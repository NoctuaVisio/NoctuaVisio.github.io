"""Database engine and session factory.

DATABASE_URL points at the local docker Postgres during development and at
Cloud SQL in deployed environments.
"""
import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

def _database_url() -> str:
    """DATABASE_URL wins; otherwise build the Cloud SQL unix-socket URL.

    On Cloud Run the password arrives as a mounted secret rather than baked into
    a URL, so the parts are assembled here instead of being pasted together in a
    deploy command where they would end up in shell history and logs.
    """
    explicit = os.environ.get("DATABASE_URL")
    if explicit:
        return explicit
    conn = os.environ.get("INSTANCE_CONNECTION_NAME")
    if conn:
        user = quote_plus(os.environ.get("DB_USER", "noctua"))
        password = quote_plus(os.environ.get("DB_PASSWORD", ""))
        name = os.environ.get("DB_NAME", "noctua")
        return f"postgresql+psycopg://{user}:{password}@/{name}?host=/cloudsql/{conn}"
    # Local development: the Postgres on the dev machine.
    return "postgresql+psycopg://noctua:noctua@127.0.0.1:55432/noctua"


DATABASE_URL = _database_url()


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def get_session():
    with SessionLocal() as session:
        yield session
