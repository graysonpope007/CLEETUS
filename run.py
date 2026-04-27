import uvicorn
from cleetus.config import SECRET_TOKEN

if __name__ == "__main__":
    if not SECRET_TOKEN:
        print("WARNING: SECRET_TOKEN is not set — all API endpoints are unprotected.")
        print("         Add SECRET_TOKEN=<your-token> to your .env file.")
    uvicorn.run("cleetus.main:app", host="0.0.0.0", port=8000, reload=True)
