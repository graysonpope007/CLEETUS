import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CHAT_MODEL = os.environ.get("CHAT_MODEL", "claude-opus-4-7")
EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "claude-haiku-4-5")
DATA_DIR = Path("data")
DB_PATH = DATA_DIR / "cleetus.db"
