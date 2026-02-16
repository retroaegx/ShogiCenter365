# -*- coding: utf-8 -*-
from flask import current_app

def _socketio():
    ext = getattr(current_app, 'extensions', {}) or {}
    return ext.get('socketio') or getattr(current_app, 'socketio', None)

def emit_offer_created(to_user_id, from_user, time_minutes):
    sio = _socketio()
    if not sio: return
    payload = {
        'type': 'offer_created',
        'to_user_id': str(to_user_id) if to_user_id else None,
        'from_user': from_user or {},
        'time_minutes': int(time_minutes or 0),
    }
    try:
        sio.emit('lobby_offer_update', payload, room='lobby')
    except Exception:
        pass

def emit_offer_status(to_user_id, from_user_id, status):
    sio = _socketio()
    if not sio: return
    payload = {
        'type': 'offer_status',
        'to_user_id': str(to_user_id) if to_user_id else None,
        'from_user_id': str(from_user_id) if from_user_id else None,
        'status': status,
    }
    try:
        sio.emit('lobby_offer_update', payload, room='lobby')
    except Exception:
        pass

