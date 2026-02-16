# -*- coding: utf-8 -*-

from __future__ import annotations

from typing import Any, Dict

from flask import jsonify, request

from ..security import login_required
from ..services.user_admin_service import UserAdminService


def _read_payload() -> Dict[str, Any]:
    """Read payload from JSON or form."""
    if request.is_json:
        try:
            data = request.get_json(silent=True) or {}
            if isinstance(data, dict):
                return data
        except Exception:
            return {}
    # form fallback
    return {
        'name': request.form.get('name') or '',
        'message': request.form.get('message') or '',
    }


def register(app) -> None:
    svc = UserAdminService(app.dbm, moderation=getattr(app, "mod", None))

    @app.get('/api/warning-templates')
    @login_required
    def admin_api_warning_templates():
        return jsonify({'templates': svc.list_warning_templates()})

    @app.post('/api/warning-templates')
    @login_required
    def admin_api_add_warning_template():
        p = _read_payload()
        name = (p.get('name') or '').strip()
        message = (p.get('message') or '').strip()
        _id = None
        if message:
            _id = svc.add_warning_template(name=name, message=message)
        return jsonify({'ok': bool(_id), 'id': str(_id) if _id else None, 'templates': svc.list_warning_templates()})
