import os

DEFAULT_CHATBOT_WS_BASE_URL = "wss://tutor-backend.iapps.bond/ws"
DEV_CHATBOT_WS_BASE_URL = "ws://localhost:8001/ws"
_DEV_ENV_VALUES = {"dev", "development", "local"}


def is_dev_environment():
    """Return True only when APP_ENV explicitly selects local development mode."""
    return os.getenv("APP_ENV", "prod").strip().lower() in _DEV_ENV_VALUES


def default_chatbot_ws_base_url():
    """Return the default WebSocket URL for the active APP_ENV (prod by default)."""
    return DEV_CHATBOT_WS_BASE_URL if is_dev_environment() else DEFAULT_CHATBOT_WS_BASE_URL
