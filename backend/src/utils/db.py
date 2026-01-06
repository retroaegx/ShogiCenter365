# -*- coding: utf-8 -*-
from flask import current_app

class DatabaseNotFound(RuntimeError):
    pass

def get_db_from_app(app):
    db = getattr(app, 'mongo_db', None)
    if db is None:
        db = app.config.get('MONGO_DB', None)
    if db is None:
        raise DatabaseNotFound('database handle not found')
    return db

def get_db():
    return get_db_from_app(current_app)