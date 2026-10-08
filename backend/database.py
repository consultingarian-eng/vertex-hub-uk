"""The one Mongo client and database every module uses.

DB_NAME has ONE default, here. Every route imports `db` from this module
rather than opening its own client, so no part of the app can end up on a
different database because of a different fallback name. Always set DB_NAME
yourself (docs/SETUP.md); the default exists only so a bare local run starts.
"""
from motor.motor_asyncio import AsyncIOMotorClient
import os

DEFAULT_DB_NAME = "test_database"
DB_NAME = (os.environ.get("DB_NAME") or "").strip() or DEFAULT_DB_NAME

mongo_url = (os.environ.get('MONGO_URL') or 'mongodb://localhost:27017')
client = AsyncIOMotorClient(mongo_url)
db = client[DB_NAME]
