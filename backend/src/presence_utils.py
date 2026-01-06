from flask import current_app

def get_db():
    # Avoid PyMongo Database truthiness: DO NOT use `or` which calls bool().
    db = getattr(current_app, "mongo_db", None)
    if db is None:
        db = current_app.config.get("MONGO_DB", None)
    if db is None:
        raise RuntimeError("db_not_ready")
    return db

def ensure_online_ttl():
    db = get_db()
    ttl = current_app.config.get("ONLINE_USERS_TTL_SECONDS", None)
    if ttl is None:
        raise RuntimeError("ONLINE_USERS_TTL_SECONDS is required (src.config.Config)")
    coll = db["online_users"]
    try:
        db.command({"collMod": "online_users", "index": {"name": "ttl_last_seen_at", "expireAfterSeconds": int(ttl)}})
    except Exception:
        try:
            for ix in coll.list_indexes():
                if ix.get("key") == {"last_seen_at": 1}:
                    coll.drop_index(ix["name"])
        except Exception:
            pass
        coll.create_index("last_seen_at", expireAfterSeconds=int(ttl), name="ttl_last_seen_at")
    try:
        coll.create_index("user_id", unique=True)
    except Exception:
        pass
