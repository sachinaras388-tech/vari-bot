import logging
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorClient

from backend.config.settings import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
settings = get_settings()


class Database:
    """Singleton holder for the shared MongoDB client and database."""

    client: Optional[AsyncIOMotorClient] = None
    db = None


db_instance = Database()


async def ensure_indexes() -> None:
    """Create a small set of high-value indexes once at startup."""
    if db_instance.db is None:
        return

    try:
        await db_instance.db["users"].create_index([("platform_id", 1)])
        await db_instance.db["users"].create_index([("phone", 1)])
        await db_instance.db["groups"].create_index([("group_id", 1)])
        await db_instance.db["blocked_users"].create_index([("phone", 1)])
        await db_instance.db["blocked_groups"].create_index([("group_id", 1)])
        await db_instance.db["chat_settings"].create_index([("chat_id", 1)])
        await db_instance.db["notes"].create_index([("subject", 1), ("type", 1), ("upvotes", -1)])
        await db_instance.db["reminders"].create_index([("user_id", 1), ("is_completed", 1), ("due_date", 1)])
        logger.info("Mongo indexes ensured")
    except Exception:
        logger.exception("Failed to ensure Mongo indexes")


import certifi

def validate_mongodb_uri(uri: str) -> None:
    if not uri:
        return
        
    logger.info("MongoDB URI configured: YES")
    logger.info(f"MongoDB database configured: {settings.DATABASE_NAME}")
    
    if not uri.startswith("mongodb://") and not uri.startswith("mongodb+srv://"):
        logger.error("❌ Invalid MongoDB URI: Must start with 'mongodb://' or 'mongodb+srv://'")
    
    if "@" in uri:
        auth_part = uri.split("@")[0]
        prefix = "mongodb+srv://" if uri.startswith("mongodb+srv://") else "mongodb://"
        auth_part = auth_part.replace(prefix, "")
        if ":" in auth_part:
            pwd_part = auth_part.split(":", 1)[1]
            if "%" not in pwd_part and any(c in pwd_part for c in "@#/:?&"):
                logger.warning("⚠️ MongoDB password contains special characters that are not URL-encoded.")
                logger.warning("If your password contains @, #, %, /, :, ?, or &, it MUST be URL-encoded (e.g. %40 for @).")

async def connect_to_mongo() -> None:
    """Create a single shared MongoDB client and validate it once."""
    if db_instance.client is not None:
        return

    if not settings.MONGODB_URI:
        logger.warning("MONGODB_URI is not set; skipping Mongo connection.")
        db_instance.client = None
        db_instance.db = None
        return

    validate_mongodb_uri(settings.MONGODB_URI)

    try:
        logger.info("⏳ Connecting to MongoDB...")
        db_instance.client = AsyncIOMotorClient(
            settings.MONGODB_URI,
            maxPoolSize=50,
            minPoolSize=5,
            serverSelectionTimeoutMS=10000,
            connectTimeoutMS=10000,
            connect=False,
            retryWrites=True,
            tlsCAFile=certifi.where()
        )
        db_instance.db = db_instance.client[settings.DATABASE_NAME]

        await db_instance.client.admin.command("ping")
        await ensure_indexes()
        logger.info("✅ Successfully connected to MongoDB!")
    except Exception:
        db_instance.client = None
        db_instance.db = None
        logger.error("❌ MongoDB connection failed.")
        logger.error("Possible causes:")
        logger.error("1. MongoDB Atlas cluster is paused/stopped.")
        logger.error("2. Current IP is not allowed in Atlas Network Access.")
        logger.error("3. MongoDB credentials are incorrect.")
        logger.error("4. MongoDB URI is invalid.")
        logger.error("5. Network/DNS connection to Atlas is blocked.")
        raise


async def close_mongo_connection() -> None:
    """Close the shared MongoDB connection gracefully."""
    if db_instance.client:
        db_instance.client.close()
        db_instance.client = None
        db_instance.db = None
        logger.info("🛑 MongoDB connection closed.")


def get_db():
    """FastAPI dependency returning the shared Mongo database handle."""
    return db_instance.db