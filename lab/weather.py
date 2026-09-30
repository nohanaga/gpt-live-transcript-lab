"""Fetch only the current forecast-model values for a supported city from USER SRT speech.

This is not general natural-language routing. It handles a limited set of phrasings
(Japanese or English, depending on the current language): a city name with a short
weather or temperature request, and subsequent city corrections. A weather request
without a time is also limited to current values; "today", "tomorrow", the past,
specific times, and periods ask for clarification.

Primary sources for the API, the meaning of model values, and WMO codes:
https://open-meteo.com/en/docs
https://open-meteo.com/en/docs/geocoding-api
Terms of use for the free public API: https://open-meteo.com/en/terms
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import httpx

from lab.i18n import current_language, text


MAX_SUMMARY_BYTES = 480


def _bounded_summary(message: str) -> str:
    encoded = message.encode("utf-8")
    if len(encoded) <= MAX_SUMMARY_BYTES:
        return message
    return encoded[: MAX_SUMMARY_BYTES - 3].decode("utf-8", errors="ignore") + "…"


class WeatherInputError(ValueError):
    """A clarification message (at most 480 UTF-8 bytes) when the target or request is unclear."""

    def __init__(self, message: str) -> None:
        super().__init__(_bounded_summary(message))


class WeatherServiceError(RuntimeError):
    """A description (at most 480 UTF-8 bytes) of a communication failure or invalid API response."""

    def __init__(self, message: str) -> None:
        super().__init__(_bounded_summary(message))


# Keys are the canonical (Japanese) city names. Values are the English city name (also used
# as the geocoding query), the expected prefecture in Japanese, and the prefecture in English.
# Coordinates are fetched from the API.
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
SUPPORTED_CITIES_EN: tuple[str, ...] = tuple(names[0] for names in _CITIES.values())
_FROM_ENGLISH = {names[0]: city for city, names in _CITIES.items()}


def supported_cities() -> tuple[str, ...]:
    """City names accepted as function arguments in the current language."""
    return SUPPORTED_CITIES_EN if current_language() == "en" else SUPPORTED_CITIES


def _canonical_city(city: object) -> str | None:
    if not isinstance(city, str):
        return None
    if current_language() == "en":
        return _FROM_ENGLISH.get(city)
    return city if city in _CITIES else None


def _display_city(canonical: str) -> str:
    return _CITIES[canonical][0] if current_language() == "en" else canonical


# Japanese grammar: aliases map spoken forms to canonical names.
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

# English grammar: case-folded spoken forms map to canonical names.
_ALIASES_EN = {names[0].casefold(): city for city, names in _CITIES.items()}
_ALIASES_EN.update({f"{names[0]} city".casefold(): city for city, names in _CITIES.items() if city != "東京"})
_ALIASES_EN["tokyo metropolis"] = "東京"
_CITY_PATTERN_EN = "|".join(re.escape(alias) for alias in sorted(_ALIASES_EN, key=len, reverse=True))
_NOW_EN = r"(?:right now|now|currently|at the moment|at present)"
_LEAD_EN = (
    r"(?:(?:please |can you |could you )?"
    r"(?:search(?: for)?|look up|check|find|get|tell me|show me|give me|"
    r"i want to know|i'd like to know) )?"
    r"(?:(?:what|how)(?:'s| is) )?(?:the )?"
)
_TOPIC_EN = r"(?:current )?(?:weather forecast|weather conditions|weather|temperature)"
_WEATHER_REQUEST_EN = re.compile(
    rf"{_LEAD_EN}(?:(?P<city>{_CITY_PATTERN_EN})(?:'s)? )?(?:{_NOW_EN} )?{_TOPIC_EN}"
    rf"(?: like)?(?: (?:in|for|at) (?P<place>{_CITY_PATTERN_EN}))?(?: like)?"
    rf"(?:,? {_NOW_EN})?(?:,? please)?"
)
_LOCATION_EN = re.compile(
    r"(?:(?:i'm in|i am in|i live in|i'm staying in|it's|it is|make it|change it to|"
    r"change to|switch to|in|for) )?"
    rf"(?P<city>{_CITY_PATTERN_EN})(?: instead)?(?:,? please)?"
)
_CORRECTION_MARKER_EN = r"(?:no|nope|sorry|correction|i mean|actually)"
_CORRECTION_BEFORE_EN = re.compile(rf"not (?:in |for )?(?:{_CITY_PATTERN_EN}),? (?:but )?(.+)")
_CORRECTION_AFTER_EN = re.compile(
    rf"(.+?),? (?:not|rather than|instead of) (?:in |for )?(?:{_CITY_PATTERN_EN})"
)
_NOW_WORD_EN = re.compile(r"\b(?:right now|now|current|currently|at the moment|at present)\b")
_WEATHER_WORD_EN = re.compile(r"\b(?:weather|temperature)\b")
_OTHER_TIME_EN = re.compile(
    r"\b(?:today|tonight|tomorrow|yesterday|past|future|forecast period|"
    r"morning|afternoon|evening|night|noon|midnight|week|weekend|weekly|daily|hourly|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"january|february|march|april|may|june|july|august|september|october|november|december|"
    r"last|next|later|ago|earlier|days?|hours?|minutes?|months?|years?)\b"
    r"|[0-9]+ ?(?:am|pm|a\.m\.|p\.m\.|o'clock)|[0-9]+:[0-9]"
)

_TIMESTAMP = r"[0-9]{2,9}:[0-5][0-9]:[0-5][0-9],[0-9]{3}"
_SRT = re.compile(
    rf"[1-9][0-9]*\n(?P<start>{_TIMESTAMP}) --> (?P<end>{_TIMESTAMP})\n"
    r"(?P<role>USER|ASSISTANT): (?P<text>[\s\S]+)"
)
# Clarification kinds; the text is rendered in the current language when raised.
_INPUT, _CITY, _TIME = "input", "city", "time"


def _clarification(kind: str) -> str:
    if kind == _CITY:
        return text(
            "どの都市の天気ですか。対応都市は" + "、".join(SUPPORTED_CITIES) + "です。",
            "Which city's weather would you like? Supported cities: " + ", ".join(SUPPORTED_CITIES_EN) + ".",
        )
    if kind == _TIME:
        return text(
            "取得できるのは現在の予報モデル値だけです。日別予報、過去、時刻や期間指定には"
            "対応していません。「今の天気」でよいか、都市名とともに指定してください。",
            "Only the current forecast-model value is available. Daily forecasts, the past, and "
            "specific times or periods are not supported. Please confirm that the current weather "
            "is fine, together with the city name.",
        )
    return text(
        "対応都市を1つ指定し、「東京の今の天気を教えて」のように依頼してください。"
        "複数都市、未対応の地名、天気以外の依頼には対応していません。",
        "Please name one supported city and ask something like "
        "\"What's the weather in Tokyo right now?\". "
        "Multiple cities, unsupported places, and non-weather requests are not supported.",
    )


_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_HTTP_TIMEOUT = httpx.Timeout(10.0)
_REQUEST_DEADLINE = 15.0
_MAX_RESPONSE_BYTES = 65_536
_MAX_TRANSCRIPT_CHARS = 131_072
_JST = timezone(timedelta(hours=9))
_MONTHS_EN = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
# WMO weather codes: (Japanese, English).
_WEATHER_CODES = {
    0: ("晴れ", "clear sky"), 1: ("おおむね晴れ", "mainly clear"),
    2: ("一部に雲", "partly cloudy"), 3: ("曇り", "overcast"),
    45: ("霧", "fog"), 48: ("着氷性の霧", "depositing rime fog"),
    51: ("弱い霧雨", "light drizzle"), 53: ("霧雨", "drizzle"), 55: ("強い霧雨", "dense drizzle"),
    56: ("弱い着氷性の霧雨", "light freezing drizzle"), 57: ("強い着氷性の霧雨", "dense freezing drizzle"),
    61: ("弱い雨", "light rain"), 63: ("雨", "rain"), 65: ("強い雨", "heavy rain"),
    66: ("弱い着氷性の雨", "light freezing rain"), 67: ("強い着氷性の雨", "heavy freezing rain"),
    71: ("弱い雪", "light snow"), 73: ("雪", "snow"), 75: ("強い雪", "heavy snow"), 77: ("霧雪", "snow grains"),
    80: ("弱いにわか雨", "light rain showers"), 81: ("にわか雨", "rain showers"),
    82: ("激しいにわか雨", "violent rain showers"),
    85: ("弱いにわか雪", "light snow showers"), 86: ("強いにわか雪", "heavy snow showers"),
    95: ("雷雨", "thunderstorm"), 96: ("弱いひょうを伴う雷雨", "thunderstorm with light hail"),
    97: ("強い雷雨", "heavy thunderstorm"), 99: ("強いひょうを伴う雷雨", "thunderstorm with heavy hail"),
}


def _timestamp_ms(value: str) -> int:
    hours, minutes, seconds, millis = map(int, re.split(r"[:,]", value))
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _user_turns(transcript_srt: str) -> list[str]:
    if not isinstance(transcript_srt, str) or not 0 < len(transcript_srt) <= _MAX_TRANSCRIPT_CHARS:
        raise WeatherInputError(text(
            "上限131072文字以内の、空でない SRT 会話履歴を渡してください。",
            "Provide a non-empty SRT conversation history of at most 131072 characters.",
        ))
    blocks = re.split(r"\n(?:[ \t]*\n)+(?=[0-9]+\n)", transcript_srt.replace("\r\n", "\n").strip())
    if len(blocks) > 512:
        raise WeatherInputError(text(
            "SRT の項目数が上限512件を超えています。",
            "The SRT has more than the maximum of 512 entries.",
        ))
    turns: list[str] = []
    previous_user_start: str | None = None
    for block in blocks:
        match = _SRT.fullmatch(block)
        if match is None or _timestamp_ms(match["end"]) <= _timestamp_ms(match["start"]):
            raise WeatherInputError(text(
                "USER / ASSISTANT 表記を含む正しい SRT 会話履歴が必要です。",
                "A valid SRT conversation history with USER / ASSISTANT labels is required.",
            ))
        if match["role"] == "ASSISTANT":
            previous_user_start = None
            continue
        # Repeated consume_srt() calls turn the continuation of an utterance with the
        # same start time into a new entry, so join it back to the previous USER turn.
        if turns and previous_user_start == match["start"]:
            turns[-1] += match["text"]
        else:
            turns.append(match["text"])
        previous_user_start = match["start"]
    return turns


def _resolve_city_ja(turns: list[str]) -> tuple[str | None, bool, str | None]:
    city: str | None = None
    weather_requested = False
    clarification: str | None = _INPUT
    for turn in turns:
        speech_text = "".join(unicodedata.normalize("NFKC", turn).split())
        for speech in re.split(r"[、。,!]+(?:いいえ|いえ|いや|訂正)[、。,:]*", speech_text):
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
                if clarification != _TIME or re.search(r"現時点|現在|いま|今", speech):
                    clarification = None if city else _CITY
            elif location:
                city = _ALIASES[location["city"]]
                if weather_requested and clarification in (None, _CITY):
                    clarification = None
            else:
                city = None
                weather_requested = False
                clarification = (
                    _TIME if _OTHER_TIME.search(speech) and re.search(r"天気|気温|天候", speech) else _INPUT
                )
    return city, weather_requested, clarification


def _resolve_city_en(turns: list[str]) -> tuple[str | None, bool, str | None]:
    city: str | None = None
    weather_requested = False
    clarification: str | None = _INPUT
    for turn in turns:
        normalized = unicodedata.normalize("NFKC", turn).replace("\u2019", "'")
        speech_text = " ".join(normalized.split()).casefold()
        for speech in re.split(rf"[,.;!?]+ ?{_CORRECTION_MARKER_EN}\b[,.:!]* ?", speech_text):
            speech = re.sub(rf"^{_CORRECTION_MARKER_EN}\b[,.:!]* ?", "", speech).strip(" .!?")
            correction = _CORRECTION_BEFORE_EN.fullmatch(speech) or _CORRECTION_AFTER_EN.fullmatch(speech)
            if correction:
                speech = correction[1]
            request = _WEATHER_REQUEST_EN.fullmatch(speech)
            # Two different places in one request ("Tokyo weather in Osaka") are ambiguous.
            if request and request["city"] and request["place"]:
                request = None
            location = _LOCATION_EN.fullmatch(speech)
            if request:
                weather_requested = True
                named = request["city"] or request["place"]
                if named:
                    city = _ALIASES_EN[named]
                if clarification != _TIME or _NOW_WORD_EN.search(speech):
                    clarification = None if city else _CITY
            elif location:
                city = _ALIASES_EN[location["city"]]
                if weather_requested and clarification in (None, _CITY):
                    clarification = None
            else:
                city = None
                weather_requested = False
                clarification = (
                    _TIME if _OTHER_TIME_EN.search(speech) and _WEATHER_WORD_EN.search(speech) else _INPUT
                )
    return city, weather_requested, clarification


def _resolve_city(transcript_srt: str) -> str:
    """Return the canonical city for the latest USER request, or raise a clarification."""
    turns = _user_turns(transcript_srt)
    resolve = _resolve_city_en if current_language() == "en" else _resolve_city_ja
    city, weather_requested, clarification = resolve(turns)
    if clarification or not weather_requested or city is None:
        raise WeatherInputError(_clarification(clarification or _INPUT))
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
    # Do not forward the shared client's default query, auth, or cookies to the external service.
    request = httpx.Request(
        "GET", url,
        headers={"Accept": "application/json", "Accept-Encoding": "identity"},
        extensions={"timeout": _HTTP_TIMEOUT.as_dict()},
    )
    response = await client.send(request, stream=True, auth=None, follow_redirects=False)
    try:
        if response.status_code != 200:
            raise WeatherServiceError(text(
                f"天気サービスが HTTP {response.status_code} を返しました。",
                f"The weather service returned HTTP {response.status_code}.",
            ))
        if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise WeatherServiceError(text(
                "天気サービスの応答形式が JSON ではありません。",
                "The weather service response is not JSON.",
            ))
        # Compressed data could exceed the limit when decompressed, so only uncompressed responses are accepted.
        if response.headers.get("content-encoding", "identity").strip().lower() != "identity":
            raise WeatherServiceError(text(
                "天気サービスから未対応の圧縮応答を受信しました。",
                "Received an unsupported compressed response from the weather service.",
            ))
        length = response.headers.get("content-length")
        if length is not None and (
            not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > _MAX_RESPONSE_BYTES
        ):
            raise WeatherServiceError(text(
                "天気サービスの応答サイズが不正または上限超過です。",
                "The weather service response size is invalid or exceeds the limit.",
            ))
        body = bytearray()
        async for chunk in response.aiter_bytes():
            if len(body) + len(chunk) > _MAX_RESPONSE_BYTES:
                raise WeatherServiceError(text(
                    "天気サービスの応答が65536バイトの上限を超えました。",
                    "The weather service response exceeded the 65536-byte limit.",
                ))
            body.extend(chunk)
        result = json.loads(
            body.decode("utf-8"), object_pairs_hook=_json_object, parse_constant=_reject_constant
        )
        if not isinstance(result, dict) or "error" in result:
            raise WeatherServiceError(text(
                "天気サービスから正常な JSON オブジェクトを取得できませんでした。",
                "Could not get a valid JSON object from the weather service.",
            ))
        return result
    finally:
        await response.aclose()


async def _get_json(client: httpx.AsyncClient, url: httpx.URL) -> dict[str, object]:
    try:
        return await asyncio.wait_for(_read_json(client, url), timeout=_REQUEST_DEADLINE)
    except (httpx.HTTPError, TimeoutError, ValueError, UnicodeError, RecursionError):
        raise WeatherServiceError(text(
            "天気サービスとの通信、または JSON 応答の検証に失敗しました。",
            "Communication with the weather service, or validation of its JSON response, failed.",
        )) from None


def _number(value: object, minimum: float, maximum: float) -> float:
    if (
        type(value) not in (int, float)
        or not minimum <= value <= maximum
        or not math.isfinite(value)
    ):
        raise WeatherServiceError(text(
            "天気サービスの数値が欠落、不正、または範囲外です。",
            "A weather service number is missing, invalid, or out of range.",
        ))
    return float(value)


def _normalized_name(value: str) -> str:
    return "".join(
        character for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    ).casefold()


def _coordinates(payload: dict[str, object], city: str) -> tuple[float, float]:
    results = payload.get("results")
    if not isinstance(results, list) or not 1 <= len(results) <= 10:
        raise WeatherServiceError(text(
            "天気サービスで対象都市の座標を確認できませんでした。",
            "The weather service could not confirm the coordinates of the city.",
        ))
    english, region, english_region = _CITIES[city]
    # Accept both the Japanese and English names so either geocoding language matches.
    names = {_normalized_name(name) for name, canonical in _ALIASES.items() if canonical == city}
    names.update(_normalized_name(name) for name, canonical in _ALIASES_EN.items() if canonical == city)
    names.add(_normalized_name(english))
    regions = {_normalized_name(region), _normalized_name(english_region)}
    matches: list[tuple[float, float]] = []
    for result in results:
        if not isinstance(result, dict) or any(
            not isinstance(result.get(field), str)
            for field in ("name", "country_code", "admin1", "timezone", "feature_code")
        ):
            raise WeatherServiceError(text(
                "地名検索の応答に必要な項目がありません。",
                "The geocoding response is missing required fields.",
            ))
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
        raise WeatherServiceError(text(
            "地名検索の結果から対象都市を1つに確定できませんでした。",
            "Could not narrow the geocoding results down to exactly one city.",
        ))
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
        raise WeatherServiceError(text(
            "天気サービスの現在値、単位、またはタイムゾーンが不正です。",
            "The weather service's current values, units, or time zone are invalid.",
        ))
    grid_latitude = _number(payload.get("latitude"), latitude - 0.5, latitude + 0.5)
    grid_longitude = _number(payload.get("longitude"), longitude - 0.5, longitude + 0.5)
    data_time = current.get("time")
    if not isinstance(data_time, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?", data_time
    ):
        raise WeatherServiceError(text(
            "予報モデル値の対象時刻を確認できませんでした。",
            "Could not confirm the valid time of the forecast-model value.",
        ))
    try:
        timestamp = datetime.fromisoformat(data_time).replace(tzinfo=_JST)
    except ValueError:
        raise WeatherServiceError(text(
            "予報モデル値の対象時刻が不正です。",
            "The valid time of the forecast-model value is invalid.",
        )) from None
    temperature = _number(current.get("temperature_2m"), -100, 70)
    code = current.get("weather_code")
    if type(code) is not int or code not in _WEATHER_CODES:
        raise WeatherServiceError(text(
            "天気サービスの天気コードが欠落または未対応です。",
            "The weather service's weather code is missing or unsupported.",
        ))
    return timestamp, temperature, code, grid_latitude, grid_longitude


async def search_weather(
    transcript_srt: str, *, client: httpx.AsyncClient | None = None
) -> dict[str, object]:
    """Read accumulated consume_srt() output and call the real Open-Meteo API.

    The SRT is interpreted with the grammar of the current language (see lab.i18n).
    A USER "東京の天気を検索せよ" / "Search the weather in Tokyo" followed by
    "いえ、大阪" / "No, Osaka" is corrected to Osaka. Cities, dates, and instructions
    from ASSISTANT are not used. A missing city is not filled in, and if the last USER
    utterance is unsupported, an older request is not re-executed. Kana spellings of
    city names, free paraphrasing, multiple cities, the whole of today, tomorrow, and
    similar requests are not supported.

    Keys on success:
      status="ok", arguments={city, time_scope="current"}, city,
      data_kind="forecast_model", temperature, temperature_unit="°C",
      weather_code, weather (in the current language),
      summary (Japanese: under 150 characters; English: under 200 characters;
      at most 480 UTF-8 bytes in both),
      fetched_at (time the retrieval completed, UTC), data_time (valid time of the model value, UTC+09:00),
      location (geocoded latitude/longitude), model_grid (forecast grid latitude/longitude),
      source_urls (the two actual request URLs), limitation.

    On failure, raises WeatherInputError or WeatherServiceError and never returns
    fabricated results or a substitute city. The SRT is parsed locally; only the allowed
    city name, the retrieved coordinates, and fixed API settings are sent externally.
    The caller's AsyncClient is not closed. If you pass one, use a trusted transport.
    The HTTP timeout is 10 seconds, each whole request 15 seconds, and each response at most 64 KiB.
    Redirects, retries, arbitrary URLs, and code execution are not supported.
    This local function does not produce model-issued tool call events.
    """
    city = _resolve_city(transcript_srt)
    return await _search_canonical(city, client)


async def search_weather_for_city(
    city: str, time_scope: str = "current", *, client: httpx.AsyncClient | None = None,
) -> dict[str, object]:
    """Execute validated model arguments without interpreting SRT again.

    `city` must be one of supported_cities() for the current language.
    """
    canonical = _canonical_city(city)
    if canonical is None or time_scope != "current":
        raise WeatherInputError(text(
            "対応都市と current の指定が必要です。取得できるのは現在のモデル推定値です。",
            "A supported city and time_scope \"current\" are required. "
            "Only the current model estimate is available.",
        ))
    return await _search_canonical(canonical, client)


async def _search_canonical(city: str, client: httpx.AsyncClient | None) -> dict[str, object]:
    if client is None:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, follow_redirects=False, trust_env=False) as owned:
            return await _search(city, owned)
    return await _search(city, client)


def _summary(city: str, timestamp: datetime, weather: str, temperature: float) -> str:
    if current_language() == "en":
        return (
            f"Weather information retrieved. Open-Meteo forecast model, current estimate for {city} "
            f"as of {_MONTHS_EN[timestamp.month - 1]} {timestamp.day}, {timestamp.year}, "
            f"{timestamp.hour}:{timestamp.minute:02d} JST: {weather}, {temperature:g}°C. "
            "Not an observed value."
        )
    return (
        f"天気情報を取得しました。Open-Meteo の予報モデルによる現在の推定では、{city}は"
        f"{timestamp.year}年{timestamp.month}月{timestamp.day}日"
        f"{timestamp.hour}時{timestamp.minute:02d}分時点で"
        f"{weather}、気温{temperature:g}度です。観測値ではありません。"
    )


async def _search(city: str, client: httpx.AsyncClient) -> dict[str, object]:
    geocoding_url = httpx.URL(_GEOCODING_URL, params={
        "name": _CITIES[city][0], "count": "10", "language": current_language(), "countryCode": "JP",
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
    weather = text(*_WEATHER_CODES[code])
    display = _display_city(city)
    return {
        "status": "ok",
        "arguments": {"city": display, "time_scope": "current"},
        "city": display,
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
        "summary": _bounded_summary(_summary(display, timestamp, weather, temperature)),
        "limitation": text(
            "現在の予報モデル値のみです。観測値や一日全体の予報ではありません。",
            "Current forecast-model values only. Not observed values or a full-day forecast.",
        ),
    }
