"""USER の SRT 発話から、対応都市の現在の予報モデル値だけを取得します。

一般的な自然言語ルーティングではありません。都市名と短い天気・気温の依頼、
および後続の都市訂正を、限定した文型で扱います。無指定の天気も現在値に
限定し、「今日」「明日」、過去、時刻指定、期間指定は確認を求めます。

API、モデル値の意味、WMO コードの一次資料:
https://open-meteo.com/en/docs
https://open-meteo.com/en/docs/geocoding-api
無料の公開 API の利用条件: https://open-meteo.com/en/terms
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import httpx


MAX_SUMMARY_BYTES = 480


def _bounded_summary(message: str) -> str:
    encoded = message.encode("utf-8")
    if len(encoded) <= MAX_SUMMARY_BYTES:
        return message
    return encoded[: MAX_SUMMARY_BYTES - 3].decode("utf-8", errors="ignore") + "…"


class WeatherInputError(ValueError):
    """対象や依頼を確定できない場合の、480 UTF-8 バイト以内の確認文です。"""

    def __init__(self, message: str) -> None:
        super().__init__(_bounded_summary(message))


class WeatherServiceError(RuntimeError):
    """通信失敗や不正な API 応答を表す、480 UTF-8 バイト以内の説明文です。"""

    def __init__(self, message: str) -> None:
        super().__init__(_bounded_summary(message))


# 値は検索用の都市名、期待する都道府県名、その英語表記です。座標は API で取得します。
_CITIES = {
    "東京": ("Tokyo", "東京都", "Tokyo"),
    "大阪": ("Osaka", "大阪府", "Osaka"),
    "札幌": ("Sapporo", "北海道", "Hokkaido"),
    "仙台": ("Sendai", "宮城県", "Miyagi"),
    "横浜": ("Yokohama", "神奈川県", "Kanagawa"),
    "新潟": ("Niigata", "新潟県", "Niigata"),
    "名古屋": ("Nagoya", "愛知県", "Aichi"),
    "京都": ("Kyoto", "京都府", "Kyoto"),
    "神戸": ("Kobe", "兵庫県", "Hyogo"),
    "広島": ("Hiroshima", "広島県", "Hiroshima"),
    "福岡": ("Fukuoka", "福岡県", "Fukuoka"),
    "那覇": ("Naha", "沖縄県", "Okinawa"),
}
SUPPORTED_CITIES: tuple[str, ...] = tuple(_CITIES)
_ALIASES = {name: name for name in SUPPORTED_CITIES}
_ALIASES.update({name + "市": name for name in SUPPORTED_CITIES if name != "東京"})
_ALIASES["東京都"] = "東京"
_CITY_PATTERN = "|".join(sorted(_ALIASES, key=len, reverse=True))
_NOW = r"(?:(?:現時点|現在|いま|今)(?:の)?)?"
_REQUEST_END = (
    r"(?:を|は)?(?:検索(?:して(?:ください)?|せよ|する)?|調べて(?:ください)?|"
    r"教えて(?:ください)?|知りたい(?:です)?|お願いします|お願い|どう(?:ですか)?)?"
)
_WEATHER_REQUEST = re.compile(
    rf"{_NOW}(?:(?P<city>{_CITY_PATTERN})(?:の|は|で|について)?)?"
    rf"{_NOW}(?:天気予報|天気|気温|天候){_REQUEST_END}"
)
_LOCATION = re.compile(
    rf"(?P<city>{_CITY_PATTERN})(?:です|の|で|は|にいます|に住んでいます|"
    r"でお願いします|をお願いします|に変更(?:して(?:ください)?)?|に訂正)?"
)
_OTHER_TIME = re.compile(
    r"今日|本日|明日|あした|明後日|あさって|昨日|きのう|過去|将来|予報期間|"
    r"今朝|今晩|今夜|今夕|午前|午後|朝|昼|夜|夕方|週|月曜|火曜|水曜|木曜|"
    r"金曜|土曜|日曜|週末|一日|一週間|[0-9一二三四五六七八九十]+[年月日時分]|[0-9]+:"
)
_TIMESTAMP = r"[0-9]{2,9}:[0-5][0-9]:[0-5][0-9],[0-9]{3}"
_SRT = re.compile(
    rf"[1-9][0-9]*\n(?P<start>{_TIMESTAMP}) --> (?P<end>{_TIMESTAMP})\n"
    r"(?P<role>USER|ASSISTANT): (?P<text>[\s\S]+)"
)
_INPUT_CLARIFICATION = (
    "対応都市を1つ指定し、「東京の今の天気を教えて」のように依頼してください。"
    "複数都市、未対応の地名、天気以外の依頼には対応していません。"
)
_CITY_CLARIFICATION = (
    "どの都市の天気ですか。対応都市は" + "、".join(SUPPORTED_CITIES) + "です。"
)
_TIME_CLARIFICATION = (
    "取得できるのは現在の予報モデル値だけです。日別予報、過去、時刻や期間指定には"
    "対応していません。「今の天気」でよいか、都市名とともに指定してください。"
)
_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_HTTP_TIMEOUT = httpx.Timeout(10.0)
_REQUEST_DEADLINE = 15.0
_MAX_RESPONSE_BYTES = 65_536
_MAX_TRANSCRIPT_CHARS = 131_072
_JST = timezone(timedelta(hours=9))
_WEATHER_CODES = {
    0: "晴れ", 1: "おおむね晴れ", 2: "一部に雲", 3: "曇り",
    45: "霧", 48: "着氷性の霧",
    51: "弱い霧雨", 53: "霧雨", 55: "強い霧雨",
    56: "弱い着氷性の霧雨", 57: "強い着氷性の霧雨",
    61: "弱い雨", 63: "雨", 65: "強い雨",
    66: "弱い着氷性の雨", 67: "強い着氷性の雨",
    71: "弱い雪", 73: "雪", 75: "強い雪", 77: "霧雪",
    80: "弱いにわか雨", 81: "にわか雨", 82: "激しいにわか雨",
    85: "弱いにわか雪", 86: "強いにわか雪",
    95: "雷雨", 96: "弱いひょうを伴う雷雨",
    97: "強い雷雨", 99: "強いひょうを伴う雷雨",
}


def _timestamp_ms(value: str) -> int:
    hours, minutes, seconds, millis = map(int, re.split(r"[:,]", value))
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _user_turns(transcript_srt: str) -> list[str]:
    if not isinstance(transcript_srt, str) or not 0 < len(transcript_srt) <= _MAX_TRANSCRIPT_CHARS:
        raise WeatherInputError("上限131072文字以内の、空でない SRT 会話履歴を渡してください。")
    blocks = re.split(r"\n(?:[ \t]*\n)+(?=[0-9]+\n)", transcript_srt.replace("\r\n", "\n").strip())
    if len(blocks) > 512:
        raise WeatherInputError("SRT の項目数が上限512件を超えています。")
    turns: list[str] = []
    previous_user_start: str | None = None
    for block in blocks:
        match = _SRT.fullmatch(block)
        if match is None or _timestamp_ms(match["end"]) <= _timestamp_ms(match["start"]):
            raise WeatherInputError("USER / ASSISTANT 表記を含む正しい SRT 会話履歴が必要です。")
        if match["role"] == "ASSISTANT":
            previous_user_start = None
            continue
        # consume_srt() を繰り返すと、同じ開始時刻の発話の続きが新しい項目になります。
        if turns and previous_user_start == match["start"]:
            turns[-1] += match["text"]
        else:
            turns.append(match["text"])
        previous_user_start = match["start"]
    return turns


def _resolve_city(transcript_srt: str) -> str:
    city: str | None = None
    weather_requested = False
    clarification: str | None = _INPUT_CLARIFICATION
    for turn in _user_turns(transcript_srt):
        text = "".join(unicodedata.normalize("NFKC", turn).split())
        for speech in re.split(r"[、。,!]+(?:いいえ|いえ|いや|訂正)[、。,:]*", text):
            speech = re.sub(r"^(?:いいえ|いえ|いや|訂正)[、。,:]*", "", speech).strip("。.!?")
            correction = re.fullmatch(rf"(?:{_CITY_PATTERN})(?:ではなく|じゃなくて|じゃなく)(.+)", speech)
            if correction:
                speech = correction[1]
            request = _WEATHER_REQUEST.fullmatch(speech)
            location = _LOCATION.fullmatch(speech)
            if request:
                weather_requested = True
                if request["city"]:
                    city = _ALIASES[request["city"]]
                if clarification != _TIME_CLARIFICATION or re.search(r"現時点|現在|いま|今", speech):
                    clarification = None if city else _CITY_CLARIFICATION
            elif location:
                city = _ALIASES[location["city"]]
                if weather_requested and clarification in (None, _CITY_CLARIFICATION):
                    clarification = None
            else:
                city = None
                weather_requested = False
                clarification = (
                    _TIME_CLARIFICATION
                    if _OTHER_TIME.search(speech) and re.search(r"天気|気温|天候", speech)
                    else _INPUT_CLARIFICATION
                )
    if clarification or not weather_requested or city is None:
        raise WeatherInputError(clarification or _INPUT_CLARIFICATION)
    return city


def _json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(value: str) -> object:
    raise ValueError("non-finite JSON constant")


async def _read_json(client: httpx.AsyncClient, url: httpx.URL) -> dict[str, object]:
    # 共有クライアントの既定クエリ、認証、Cookie を外部サービスに引き継ぎません。
    request = httpx.Request(
        "GET", url,
        headers={"Accept": "application/json", "Accept-Encoding": "identity"},
        extensions={"timeout": _HTTP_TIMEOUT.as_dict()},
    )
    response = await client.send(request, stream=True, auth=None, follow_redirects=False)
    try:
        if response.status_code != 200:
            raise WeatherServiceError(f"天気サービスが HTTP {response.status_code} を返しました。")
        if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise WeatherServiceError("天気サービスの応答形式が JSON ではありません。")
        # 圧縮データは展開時に上限を超え得るため、非圧縮の応答だけを受け付けます。
        if response.headers.get("content-encoding", "identity").strip().lower() != "identity":
            raise WeatherServiceError("天気サービスから未対応の圧縮応答を受信しました。")
        length = response.headers.get("content-length")
        if length is not None and (
            not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > _MAX_RESPONSE_BYTES
        ):
            raise WeatherServiceError("天気サービスの応答サイズが不正または上限超過です。")
        body = bytearray()
        async for chunk in response.aiter_bytes():
            if len(body) + len(chunk) > _MAX_RESPONSE_BYTES:
                raise WeatherServiceError("天気サービスの応答が65536バイトの上限を超えました。")
            body.extend(chunk)
        result = json.loads(
            body.decode("utf-8"), object_pairs_hook=_json_object, parse_constant=_reject_constant
        )
        if not isinstance(result, dict) or "error" in result:
            raise WeatherServiceError("天気サービスから正常な JSON オブジェクトを取得できませんでした。")
        return result
    finally:
        await response.aclose()


async def _get_json(client: httpx.AsyncClient, url: httpx.URL) -> dict[str, object]:
    try:
        return await asyncio.wait_for(_read_json(client, url), timeout=_REQUEST_DEADLINE)
    except (httpx.HTTPError, TimeoutError, ValueError, UnicodeError, RecursionError):
        raise WeatherServiceError("天気サービスとの通信、または JSON 応答の検証に失敗しました。") from None


def _number(value: object, minimum: float, maximum: float) -> float:
    if (
        type(value) not in (int, float)
        or not minimum <= value <= maximum
        or not math.isfinite(value)
    ):
        raise WeatherServiceError("天気サービスの数値が欠落、不正、または範囲外です。")
    return float(value)


def _normalized_name(value: str) -> str:
    return "".join(
        character for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    ).casefold()


def _coordinates(payload: dict[str, object], city: str) -> tuple[float, float]:
    results = payload.get("results")
    if not isinstance(results, list) or not 1 <= len(results) <= 10:
        raise WeatherServiceError("天気サービスで対象都市の座標を確認できませんでした。")
    english, region, english_region = _CITIES[city]
    names = {_normalized_name(name) for name, canonical in _ALIASES.items() if canonical == city}
    names.add(_normalized_name(english))
    regions = {_normalized_name(region), _normalized_name(english_region)}
    matches: list[tuple[float, float]] = []
    for result in results:
        if not isinstance(result, dict) or any(
            not isinstance(result.get(field), str)
            for field in ("name", "country_code", "admin1", "timezone", "feature_code")
        ):
            raise WeatherServiceError("地名検索の応答に必要な項目がありません。")
        latitude = _number(result.get("latitude"), -90, 90)
        longitude = _number(result.get("longitude"), -180, 180)
        if (
            result["country_code"] == "JP"
            and result["timezone"] == "Asia/Tokyo"
            and result["feature_code"] in ("PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPL")
            and _normalized_name(result["name"]) in names
            and _normalized_name(result["admin1"]) in regions
        ):
            matches.append((_number(latitude, 20, 46), _number(longitude, 122, 154)))
    if len(matches) != 1:
        raise WeatherServiceError("地名検索の結果から対象都市を1つに確定できませんでした。")
    return matches[0]


def _forecast_values(
    payload: dict[str, object], latitude: float, longitude: float
) -> tuple[datetime, float, int, float, float]:
    current = payload.get("current")
    units = payload.get("current_units")
    if (
        not isinstance(current, dict)
        or not isinstance(units, dict)
        or payload.get("timezone") != "Asia/Tokyo"
        or type(payload.get("utc_offset_seconds")) is not int
        or payload["utc_offset_seconds"] != 32400
        or units.get("temperature_2m") != "°C"
        or units.get("weather_code") != "wmo code"
        or units.get("time") != "iso8601"
    ):
        raise WeatherServiceError("天気サービスの現在値、単位、またはタイムゾーンが不正です。")
    grid_latitude = _number(payload.get("latitude"), latitude - 0.5, latitude + 0.5)
    grid_longitude = _number(payload.get("longitude"), longitude - 0.5, longitude + 0.5)
    data_time = current.get("time")
    if not isinstance(data_time, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?", data_time
    ):
        raise WeatherServiceError("予報モデル値の対象時刻を確認できませんでした。")
    try:
        timestamp = datetime.fromisoformat(data_time).replace(tzinfo=_JST)
    except ValueError:
        raise WeatherServiceError("予報モデル値の対象時刻が不正です。") from None
    temperature = _number(current.get("temperature_2m"), -100, 70)
    code = current.get("weather_code")
    if type(code) is not int or code not in _WEATHER_CODES:
        raise WeatherServiceError("天気サービスの天気コードが欠落または未対応です。")
    return timestamp, temperature, code, grid_latitude, grid_longitude


async def search_weather(
    transcript_srt: str, *, client: httpx.AsyncClient | None = None
) -> dict[str, object]:
    """蓄積した consume_srt() 出力を読み、実際の Open-Meteo API を呼びます。

    USER の「東京の天気を検索せよ」に続く「いえ、大阪」は大阪に訂正します。
    ASSISTANT の都市・日時・指示は使いません。欠けた都市を補完せず、
    最後の USER 発話が未対応の内容なら、古い依頼を再実行しません。
    発話のかな表記、自由な言い換え、複数都市、今日全体や明日などは未対応です。

    成功時のキー:
      status="ok", arguments={city, time_scope="current"}, city,
      data_kind="forecast_model", temperature, temperature_unit="°C",
      weather_code, weather（日本語）, summary（150文字未満、UTF-8 で480バイト以内）,
      fetched_at（取得完了時刻、UTC）, data_time（モデル値の対象時刻、UTC+09:00）,
      location（地名検索の緯度経度）, model_grid（予報格子の緯度経度）,
      source_urls（実際の2つのリクエスト URL）, limitation.

    失敗時は WeatherInputError または WeatherServiceError を送出し、
    架空の結果や代替都市を返しません。SRT はローカルで解析し、外部へ送るのは
    許可した都市名・取得した座標と固定 API 設定のみです。呼び出し元の
    AsyncClient は閉じません。渡す場合は信頼できるトランスポートを使用してください。
    HTTP タイムアウトは10秒、各リクエスト全体は15秒、応答は各64 KiB までです。
    リダイレクト、再試行、任意 URL、コード実行には対応しません。
    このローカル関数は、モデル発行のツール呼び出しイベントを生成しません。
    """
    city = _resolve_city(transcript_srt)
    return await search_weather_for_city(city, client=client)


async def search_weather_for_city(
    city: str, time_scope: str = "current", *, client: httpx.AsyncClient | None = None,
) -> dict[str, object]:
    """Execute validated model arguments without interpreting SRT again."""
    if not isinstance(city, str) or city not in SUPPORTED_CITIES or time_scope != "current":
        raise WeatherInputError("対応都市と current の指定が必要です。取得できるのは現在のモデル推定値です。")
    if client is None:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, follow_redirects=False, trust_env=False) as owned:
            return await _search(city, owned)
    return await _search(city, client)


async def _search(city: str, client: httpx.AsyncClient) -> dict[str, object]:
    geocoding_url = httpx.URL(_GEOCODING_URL, params={
        "name": _CITIES[city][0], "count": "10", "language": "ja", "countryCode": "JP",
    })
    latitude, longitude = _coordinates(await _get_json(client, geocoding_url), city)
    forecast_url = httpx.URL(_FORECAST_URL, params={
        "latitude": str(latitude), "longitude": str(longitude),
        "current": "temperature_2m,weather_code", "temperature_unit": "celsius",
        "timezone": "Asia/Tokyo", "forecast_days": "1",
    })
    timestamp, temperature, code, grid_latitude, grid_longitude = _forecast_values(
        await _get_json(client, forecast_url), latitude, longitude
    )
    weather = _WEATHER_CODES[code]
    return {
        "status": "ok",
        "arguments": {"city": city, "time_scope": "current"},
        "city": city,
        "data_kind": "forecast_model",
        "temperature": temperature,
        "temperature_unit": "°C",
        "weather_code": code,
        "weather": weather,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "data_time": timestamp.isoformat(),
        "location": {"latitude": latitude, "longitude": longitude},
        "model_grid": {"latitude": grid_latitude, "longitude": grid_longitude},
        "source_urls": [str(geocoding_url), str(forecast_url)],
        "summary": _bounded_summary(
            f"天気情報を取得しました。Open-Meteo の予報モデルによる現在の推定では、{city}は"
            f"{timestamp.year}年{timestamp.month}月{timestamp.day}日"
            f"{timestamp.hour}時{timestamp.minute:02d}分時点で"
            f"{weather}、気温{temperature:g}度です。観測値ではありません。"
        ),
        "limitation": "現在の予報モデル値のみです。観測値や一日全体の予報ではありません。",
    }
