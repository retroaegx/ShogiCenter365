# -*- coding: utf-8 -*-
from flask import Blueprint, request, jsonify, current_app
import os
import time
import jwt
import re
import secrets
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from bson import ObjectId
from src.utils.db import get_db
from src.routes.user import _shape as _shape_user
from src.utils.mailer import send_text_email, load_smtp_config

auth_bp = Blueprint("auth", __name__)


def _err(code: str, message: str, status: int = 400, **extra):
    """Standard error response.

    Backward compatible: keep `message` while adding `error_code`.
    """
    payload = {'success': False, 'error_code': code, 'message': message}
    if extra:
        payload.update(extra)
    return jsonify(payload), int(status)

DEFAULT_SETTINGS = {
    'envSoundVolume': 50,
    'sfxVolume': 50,
    'boardDesignPreset': 'classic',
    'blockList': [],
    # 対局画面UI
    'coordVisible': True,         # 盤上の符号(座標)の表示
    'shellWidthMode': 'normal',   # 対局画面の表示サイズ: normal|wide
    'moveConfirmEnabled': False,  # 着手確認（クライアント側）
    # 感想戦UI（デフォルトOFF）
    'reviewDrawNextMove': False,  # 次の本譜手の線
    'reviewDrawBestMove': False,  # 最善手の線
}


def _env_truthy(key: str, default: bool = False) -> bool:
    v = os.environ.get(key)
    if v is None:
        return default
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on')


def _require_email_verification() -> bool:
    """Decide whether email verification is required.

    Priority:
      1) REQUIRE_EMAIL_VERIFICATION env (explicit)
      2) If SMTP is configured -> True
      3) Otherwise -> False
    """
    if os.environ.get('REQUIRE_EMAIL_VERIFICATION') is not None:
        return _env_truthy('REQUIRE_EMAIL_VERIFICATION', default=False)
    return load_smtp_config() is not None


def _generate_email_verification_token(user_id: str, email: str, *, expires_in_sec: int = 24 * 3600) -> str:
    secret = current_app.config.get('JWT_SECRET_KEY') or 'dev-secret-change-me'
    now = int(time.time())
    payload = {
        'typ': 'email_verify',
        'sub': str(user_id),
        'email': (email or '').strip().lower(),
        'iat': now,
        'exp': now + int(expires_in_sec),
    }
    t = jwt.encode(payload, secret, algorithm='HS256')
    if isinstance(t, bytes):
        return t.decode('utf-8')
    return str(t)


def _generate_password_reset_token(user_id: str, email: str, *, expires_in_sec: int = 60 * 60) -> str:
    """Generate a password reset token.

    Token is a JWT signed with JWT_SECRET_KEY and also verified against
    the latest token stored in DB (one-time use).
    """
    secret = current_app.config.get('JWT_SECRET_KEY') or 'dev-secret-change-me'
    now = int(time.time())
    payload = {
        'typ': 'pw_reset',
        'sub': str(user_id),
        'email': (email or '').strip().lower(),
        'iat': now,
        'exp': now + int(expires_in_sec),
    }
    t = jwt.encode(payload, secret, algorithm='HS256')
    if isinstance(t, bytes):
        return t.decode('utf-8')
    return str(t)


def _frontend_url() -> str:
    # Prefer env (dev/prod wrapper will map DEV_/PROD_ to FRONTEND_URL)
    u = (os.environ.get('FRONTEND_URL') or '').strip().rstrip('/')
    if u:
        return u
    # Fallback to current origin
    try:
        return request.url_root.rstrip('/')
    except Exception:
        return 'http://localhost:5000'


def _send_verification_email(*, to_email: str, token: str) -> None:
    link = f"{_frontend_url()}/verify-email.html?token={token}"
    subject = 'メールアドレスの確認'
    body = (
        '将棋センター365 です。\n\n'
        '下のリンクを開いて、メールアドレスの確認を完了してください。\n'
        f"{link}\n\n"
        'このリンクは一定時間で期限切れになります。\n'
        '心当たりがない場合は、このメールを破棄してください。\n'
    )
    send_text_email(to_email=to_email, subject=subject, body=body)


def _send_password_reset_email(*, to_email: str, token: str) -> None:
    link = f"{_frontend_url()}/reset-password.html?token={token}"
    subject = 'パスワード再設定'
    body = (
        '将棋センター365 です。\n\n'
        '下のリンクを開いて、パスワードの再設定を行ってください。\n'
        f"{link}\n\n"
        'このリンクは一定時間で期限切れになります。\n'
        '心当たりがない場合は、このメールを破棄してください。\n'
    )
    send_text_email(to_email=to_email, subject=subject, body=body)


def init_auth_routes(app, *args, **kwargs):
    return None

def _json():
    d = request.get_json(silent=True)
    if not isinstance(d, dict):
        return {}
    return d

def _verify_password(user, plain: str) -> bool:
    ph = user.get('password_hash')
    if isinstance(ph, str) and ph:
        try:
            return check_password_hash(ph, plain)
        except Exception:
            pass
    p = user.get('password')
    if isinstance(p, str) and p:
        if p.startswith('pbkdf2:'):
            try:
                return check_password_hash(p, plain)
            except Exception:
                return False
        if p.startswith('$2a$') or p.startswith('$2b$') or p.startswith('$2y$'):
            try:
                import bcrypt
                return bcrypt.checkpw(plain.encode('utf-8'), p.encode('utf-8'))
            except Exception:
                return False
        return p == plain
    return False
USERNAME_RE = re.compile(r'^[a-zA-Z0-9_]{3,}$')


def _validate_password_policy(password: str):
    """Password policy shared across registration and reset."""
    p = (password or '')
    if len(p) < 8:
        return False, 'password_too_short', 'パスワードは8文字以上で入力してください'
    if not re.search(r'[A-Z]', p):
        return False, 'password_need_upper', 'パスワードは大文字を1つ以上含めてください'
    if not re.search(r'[a-z]', p):
        return False, 'password_need_lower', 'パスワードは小文字を1つ以上含めてください'
    if not re.search(r'\d', p):
        return False, 'password_need_digit', 'パスワードは数字を1つ以上含めてください'
    return True, 'ok', p

def _validate_username(username: str):
    username = (username or '').strip()
    if not username:
        return False, 'username_required', 'ユーザー名を入力してください'
    if len(username) < 3:
        return False, 'username_too_short', 'ユーザー名は3文字以上で入力してください'
    if not USERNAME_RE.match(username):
        return False, 'username_invalid_chars', 'ユーザー名は英数字とアンダースコアのみ使用できます'
    return True, 'ok', username

def _validate_rating(value):
    try:
        r = int(value)
    except Exception:
        return False, 'rating_invalid', 'レーティングが不正です'
    if r < 0 or r > 2400:
        return False, 'rating_out_of_range', 'レーティングは0〜2400の範囲で指定してください'
    if r % 100 != 0:
        return False, 'rating_step', 'レーティングは100刻みで指定してください'
    return True, 'ok', r


LEGION_RE = re.compile(r'^[A-Za-z]{2}$')


def _normalize_legion(value, default='JP'):
    """Normalize legion (country) code.

    We store ISO 3166-1 alpha-2 like 'JP', 'US'.
    """
    try:
        s = (value or '').strip()
    except Exception:
        s = ''
    if not s:
        s = default
    if not isinstance(s, str):
        s = str(s)
    s = s.strip().upper()
    if not LEGION_RE.match(s):
        return default
    return s


_SUPPORTED_LANGS = {'ja', 'en', 'zh', 'fr', 'de', 'pl', 'it', 'pt'}


def _normalize_language(value, default=None) -> str:
    """Normalize UI language.

    Accepted inputs:
      - language code (e.g. 'en', 'ja')
      - locale (e.g. 'ja-JP', 'pt-BR')
      - English labels (e.g. 'Japanese')

    If value is empty and default is None, return None so callers can
    decide whether to overwrite existing DB value.
    """
    try:
        raw = (value or '').strip()
    except Exception:
        raw = ''
    if not raw:
        if default is None:
            return None
        return str(default)

    s = str(raw).strip().lower()

    # Accept English labels
    if s == 'japanese':
        return 'ja'
    if s == 'english':
        return 'en'
    if s == 'chinese':
        return 'zh'
    if s == 'french':
        return 'fr'
    if s == 'german':
        return 'de'
    if s == 'polish':
        return 'pl'
    if s in ('italiano', 'italian'):
        return 'it'
    if s == 'portuguese':
        return 'pt'

    base = re.split(r'[-_]', s)[0]
    if base in _SUPPORTED_LANGS:
        return base
    if s.startswith('pt'):
        return 'pt'
    if s.startswith('zh'):
        return 'zh'
    return 'en'

def _google_client_id() -> str:
    # Backend 用。フロントの VITE_GOOGLE_CLIENT_ID をそのまま流用する運用も想定してフォールバックを入れる
    return (os.environ.get('GOOGLE_CLIENT_ID') or os.environ.get('VITE_GOOGLE_CLIENT_ID') or '').strip()

def _verify_google_id_token(id_token_jwt: str) -> dict:
    client_id = _google_client_id()
    if not client_id:
        raise ValueError('GOOGLE_CLIENT_ID is not configured')
    from google.oauth2 import id_token as google_id_token
    from google.auth.transport import requests as google_requests
    req = google_requests.Request()
    return google_id_token.verify_oauth2_token(id_token_jwt, req, client_id)

def _make_google_signup_token(sub: str, email=None, name=None) -> str:
    secret = current_app.config.get('JWT_SECRET_KEY') or 'dev-secret-change-me'
    now = int(time.time())
    payload = {
        'typ': 'google_signup',
        'sub': sub,
        'email': email,
        'name': name,
        'iat': now,
        'exp': now + 600,  # 10 minutes
    }
    return jwt.encode(payload, secret, algorithm='HS256')

def _decode_google_signup_token(token: str) -> dict:
    secret = current_app.config.get('JWT_SECRET_KEY') or 'dev-secret-change-me'
    payload = jwt.decode(token, secret, algorithms=['HS256'])
    if payload.get('typ') != 'google_signup':
        raise ValueError('invalid signup token')
    return payload

def _issue_login_payload(db, u: dict):
    token = create_access_token(identity=str(u['_id']))

    # ensure settings exists / merge defaults
    settings = u.get('settings') or {}
    changed = False
    for key, default_value in DEFAULT_SETTINGS.items():
        if key not in settings or settings[key] is None:
            settings[key] = default_value
            changed = True
    if changed:
        db.users.update_one({'_id': u['_id']}, {'$set': {'settings': settings}})
        u['settings'] = settings

    # normalize presence on login (same as /login)
    try:
        db_pres = db['online_users']
        uid_obj = ObjectId(str(u['_id']))
        pres = db_pres.find_one({'user_id': uid_obj})
        waiting_state = (pres or {}).get('waiting')
        if waiting_state == 'review':
            db_pres.update_one({'user_id': uid_obj}, {'$set': {'waiting': 'lobby', 'waiting_info': {}, 'pending_offer': {}}})
        if waiting_state == 'playing':
            svc = current_app.config.get('GAME_SERVICE')
            gm = getattr(svc, 'game_model', None) if svc else None
            if gm is not None:
                active_statuses = ['active', 'ongoing', 'in_progress', 'started', 'pause']
                q = {'status': {'$in': active_statuses}, '$or': [
                    {'sente_id': uid_obj}, {'gote_id': uid_obj},
                    {'players.sente.user_id': str(u['_id'])},
                    {'players.gote.user_id': str(u['_id'])},
                ]}
                any_active = gm.find_one(q) is not None
                if not any_active:
                    db_pres.update_one({'user_id': uid_obj}, {'$set': {'waiting': 'lobby', 'waiting_info': {}}})
    except Exception:
        pass

    # One-time login warning (set by admin)
    login_warning = None
    try:
        mod = current_app.config.get('MODERATION_SERVICE')
        if mod is not None and hasattr(mod, 'consume_login_warning'):
            login_warning = mod.consume_login_warning(u)
        elif bool(u.get('login_warning_pending')):
            login_warning = (u.get('login_warning_message') or '').strip() or '運営からの警告です。利用規約をご確認ください。'
            try:
                db.users.update_one({'_id': u['_id']}, {'$set': {'login_warning_pending': False, 'login_warning_shown_at': datetime.utcnow()}, '$unset': {'login_warning_message': ''}})
            except Exception:
                pass
    except Exception:
        pass

    profile = _shape_user(u)
    profile['settings'] = u.get('settings', DEFAULT_SETTINGS)
    return token, profile, login_warning

@auth_bp.route('/register', methods=['POST'])
def register():
    db = get_db()
    b = _json()
    username_raw = (b.get('username') or '').strip()
    email = (b.get('email') or '').strip().lower()
    password = (b.get('password') or '').strip()

    ok_u, u_code, u_or_msg = _validate_username(username_raw)
    if not ok_u:
        return _err(u_code, u_or_msg, 400)
    username = u_or_msg

    rating_raw = b.get('rating')
    if rating_raw is None:
        rating_raw = b.get('initial_rating')
    if rating_raw is None:
        rating_raw = b.get('initialRating')

    if rating_raw is None or rating_raw == '':
        return _err('rating_required', 'レーティングを指定してください', 400)

    ok_r, r_code, r_or_msg = _validate_rating(rating_raw)
    if not ok_r:
        return _err(r_code, r_or_msg, 400)
    rating = r_or_msg

    legion = _normalize_legion(b.get('legion'))
    language = _normalize_language(b.get('language') or b.get('lang') or b.get('locale'), default='en')

    if not email or not password:
        return _err('missing_fields', 'username / email / password は必須です', 400)

    if db.users.find_one({'username': username}):
        return _err('username_taken', 'このユーザー名は既に使用されています', 400)
    if db.users.find_one({'email': email}):
        return _err('email_taken', 'このメールアドレスは既に使用されています', 400)

    require_verify = _require_email_verification()

    # If verification is required, ensure SMTP is configured.
    if require_verify and load_smtp_config() is None:
        return _err('smtp_not_configured', 'サーバーのメール送信設定が未完了です（SMTP）', 500)

    doc = {
        'username': username,
        'email': email,
        'password_hash': generate_password_hash(password),
        'rating': rating, 'games_played': 0, 'wins': 0, 'losses': 0, 'draws': 0,
        'created_at': datetime.utcnow(), 'is_active': True,
        'is_email_verified': (not require_verify),
        'user_kind': 'human',
        'legion': legion,
        'language': language,
    }

    # Pre-create verification token (stored in DB) so it can be re-sent.
    verification_token = None
    verification_expires_at = None
    if require_verify:
        verification_expires_at = datetime.utcnow() + timedelta(hours=24)
        # token needs user id, so we will generate after insert

    r = db.users.insert_one(doc)
    user_id = str(r.inserted_id)

    verification_sent = False
    if require_verify:
        try:
            verification_token = _generate_email_verification_token(user_id, email)
            db.users.update_one(
                {'_id': r.inserted_id},
                {'$set': {
                    'email_verification_token': verification_token,
                    'email_verification_token_expires_at': verification_expires_at,
                }}
            )
            _send_verification_email(to_email=email, token=verification_token)
            verification_sent = True
        except Exception:
            # Keep user so that /resend-verification can be used.
            current_app.logger.exception('Failed to send verification email')

    msg = None
    if require_verify:
        msg = '確認メールを送信しました。メールのリンクを開いて認証してください。'
        if not verification_sent:
            msg = 'アカウントは作成しましたが、確認メールの送信に失敗しました。時間をおいて再送してください。'

    return jsonify({
        'success': True,
        'user_id': user_id,
        'require_email_verification': require_verify,
        'verification_sent': verification_sent,
        'message': msg,
    }), 200

@auth_bp.route('/login', methods=['POST'])
def login():
    db = get_db()
    b = _json()
    identifier = (b.get('username') or b.get('email') or b.get('identifier') or '').strip()
    password = (b.get('password') or '').strip()
    language = _normalize_language(b.get('language') or b.get('lang') or b.get('locale'), default=None)
    if not identifier or not password:
        return _err('missing_credentials', 'username/email と password は必須です', 400)

    u = db.users.find_one({'$or': [{'username': identifier}, {'email': identifier.lower()}]})
    if not u or not _verify_password(u, password):
        return _err('invalid_credentials', 'invalid credentials', 401)

    # Optional email verification gate (guests are excluded)
    if _require_email_verification() and not bool(u.get('is_email_verified')) and not bool(u.get('is_guest')):
        return jsonify({
            'success': False,
            'code': 'email_unverified',
            'error_code': 'email_unverified',
            'message': 'メール認証が完了していません。確認メールのリンクを開いてください。'
        }), 403

    # Persist UI language on every login (best-effort)
    if language is not None:
        try:
            db.users.update_one({'_id': u['_id']}, {'$set': {'language': language}})
            u['language'] = language
        except Exception:
            pass

    token, profile, login_warning = _issue_login_payload(db, u)
    out = {'success': True, 'access_token': token, 'profile': profile}
    if login_warning:
        out['login_warning'] = login_warning
    return jsonify(out), 200


@auth_bp.route('/verify-email', methods=['GET', 'POST'])
def verify_email():
    """Verify email with a one-time token.

    Accepts:
      - GET /api/auth/verify-email?token=...
      - POST JSON { token: ... }
    """
    db = get_db()
    token = (request.args.get('token') or '').strip()
    if not token:
        b = _json()
        token = (b.get('token') or '').strip()
    if not token:
        return _err('token_required', 'token は必須です', 400)

    secret = current_app.config.get('JWT_SECRET_KEY') or 'dev-secret-change-me'
    try:
        payload = jwt.decode(token, secret, algorithms=['HS256'])
    except Exception:
        return _err('token_invalid_or_expired', 'token が不正か期限切れです', 401)

    if (payload or {}).get('typ') != 'email_verify':
        return _err('token_wrong_type', 'token の種類が不正です', 400)

    uid = str(payload.get('sub') or '')
    email = (payload.get('email') or '').strip().lower()
    if not uid or not email:
        return _err('token_payload_invalid', 'token の内容が不正です', 400)

    # user_id is stored as ObjectId
    try:
        oid = ObjectId(uid)
    except Exception:
        return _err('token_payload_invalid', 'token の内容が不正です', 400)

    u = db.users.find_one({'_id': oid})
    if not u:
        return _err('user_not_found', 'ユーザーが見つかりません', 404)

    if bool(u.get('is_email_verified')):
        return jsonify({'success': True, 'message': '既に認証済みです'}), 200

    # Ensure token matches the latest issued one
    if (u.get('email_verification_token') or '') != token:
        return _err('token_revoked', 'token が無効です（再発行済みの可能性があります）', 401)

    exp_at = u.get('email_verification_token_expires_at')
    if isinstance(exp_at, datetime) and exp_at < datetime.utcnow():
        return _err('token_expired', 'token の有効期限が切れています', 401)

    db.users.update_one(
        {'_id': oid},
        {'$set': {'is_email_verified': True}, '$unset': {'email_verification_token': '', 'email_verification_token_expires_at': ''}}
    )

    return jsonify({'success': True, 'message': 'メール認証が完了しました'}), 200


@auth_bp.route('/resend-verification', methods=['POST'])
def resend_verification():
    """Re-send a verification email.

    POST JSON: { email: "..." }
    """
    db = get_db()
    if load_smtp_config() is None:
        return _err('smtp_not_configured', 'サーバーのメール送信設定が未完了です（SMTP）', 500)

    b = _json()
    email = (b.get('email') or '').strip().lower()
    if not email:
        return _err('email_required', 'email は必須です', 400)

    u = db.users.find_one({'email': email})
    if not u:
        # Don’t reveal whether the email exists
        return jsonify({'success': True, 'message': '確認メールを送信しました'}), 200

    if bool(u.get('is_email_verified')):
        return jsonify({'success': True, 'message': '既に認証済みです'}), 200

    user_id = str(u.get('_id'))
    token = _generate_email_verification_token(user_id, email)
    exp_at = datetime.utcnow() + timedelta(hours=24)
    try:
        db.users.update_one(
            {'_id': u['_id']},
            {'$set': {'email_verification_token': token, 'email_verification_token_expires_at': exp_at}}
        )
        _send_verification_email(to_email=email, token=token)
    except Exception:
        current_app.logger.exception('Failed to resend verification email')
        return _err('email_send_failed', '確認メールの送信に失敗しました', 500)

    return jsonify({'success': True, 'message': '確認メールを送信しました'}), 200


@auth_bp.route('/request-password-reset', methods=['POST'])
def request_password_reset():
    """Request password reset.

    POST JSON: { email: "..." }

    Always returns success to avoid account enumeration.
    """
    db = get_db()
    if load_smtp_config() is None:
        return _err('smtp_not_configured', 'サーバーのメール送信設定が未完了です（SMTP）', 500)

    b = _json()
    email = (b.get('email') or '').strip().lower()
    if not email:
        return _err('email_required', 'email は必須です', 400)

    # Default response (do not reveal existence)
    resp = {'success': True, 'message': 'パスワード再設定の案内を送信しました。メールをご確認ください。'}

    u = db.users.find_one({'email': email})
    if not u or bool(u.get('is_guest')):
        return jsonify(resp), 200

    user_id = str(u.get('_id'))
    token = _generate_password_reset_token(user_id, email)
    exp_at = datetime.utcnow() + timedelta(hours=1)

    try:
        db.users.update_one(
            {'_id': u['_id']},
            {'$set': {'password_reset_token': token, 'password_reset_token_expires_at': exp_at}}
        )
        _send_password_reset_email(to_email=email, token=token)
    except Exception:
        # Keep response generic
        current_app.logger.exception('Failed to send password reset email')

    return jsonify(resp), 200


@auth_bp.route('/reset-password', methods=['POST'])
def reset_password():
    """Reset password with a token.

    POST JSON: { token: "...", new_password: "..." }
    """
    db = get_db()
    b = _json()
    token = (b.get('token') or '').strip()
    new_password = (b.get('new_password') or b.get('password') or '').strip()
    if not token or not new_password:
        return _err('missing_fields', 'token と new_password は必須です', 400)

    ok_p, p_code, p_or_msg = _validate_password_policy(new_password)
    if not ok_p:
        return _err(p_code, p_or_msg, 400)

    secret = current_app.config.get('JWT_SECRET_KEY') or 'dev-secret-change-me'
    try:
        payload = jwt.decode(token, secret, algorithms=['HS256'])
    except Exception:
        return _err('token_invalid_or_expired', 'token が不正か期限切れです', 401)

    if (payload or {}).get('typ') != 'pw_reset':
        return _err('token_wrong_type', 'token の種類が不正です', 400)

    uid = str(payload.get('sub') or '')
    email = (payload.get('email') or '').strip().lower()
    if not uid or not email:
        return _err('token_payload_invalid', 'token の内容が不正です', 400)

    try:
        oid = ObjectId(uid)
    except Exception:
        return _err('token_payload_invalid', 'token の内容が不正です', 400)

    u = db.users.find_one({'_id': oid})
    if not u:
        return _err('token_invalid', 'token が無効です', 401)

    # Ensure token matches the latest issued one
    if (u.get('password_reset_token') or '') != token:
        return _err('token_revoked', 'token が無効です（再発行済みの可能性があります）', 401)

    exp_at = u.get('password_reset_token_expires_at')
    if isinstance(exp_at, datetime) and exp_at < datetime.utcnow():
        return _err('token_expired', 'token の有効期限が切れています', 401)

    try:
        db.users.update_one(
            {'_id': oid},
            {'$set': {'password_hash': generate_password_hash(new_password)},
             '$unset': {'password_reset_token': '', 'password_reset_token_expires_at': '', 'password': ''}}
        )
    except Exception:
        current_app.logger.exception('Failed to reset password')
        return _err('password_update_failed', 'パスワードの更新に失敗しました', 500)

    return jsonify({'success': True, 'message': 'パスワードを更新しました。ログインしてください。'}), 200


@auth_bp.route('/guest', methods=['POST'])
def guest_login():
    """Create a temporary guest account and log in.

    - username: generated as "Guest_<suffix>" (unique)
    - users document includes expiresAt (UTC) so Mongo TTL index can auto-delete after 24h
    - returns the same payload as /login so the frontend can reuse normal flow
    """
    db = get_db()
    b = _json()

    rating_raw = b.get('rating')
    if rating_raw is None:
        rating_raw = b.get('initial_rating')
    if rating_raw is None:
        rating_raw = b.get('initialRating')

    if rating_raw is None or rating_raw == '':
        return _err('rating_required', 'レーティングを指定してください', 400)

    ok_r, r_code, r_or_msg = _validate_rating(rating_raw)
    if not ok_r:
        return _err(r_code, r_or_msg, 400)
    rating = r_or_msg

    legion = _normalize_legion(b.get('legion'))
    language = _normalize_language(b.get('language') or b.get('lang') or b.get('locale'), default='en')

    # generate unique guest username
    username = None
    for _ in range(80):
        suffix = secrets.token_hex(4)  # 8 hex chars
        cand = f"Guest_{suffix}"
        if not db.users.find_one({'username': cand}):
            username = cand
            break
    if not username:
        return _err('guest_name_generation_failed', 'ゲスト名の生成に失敗しました', 500)

    now = datetime.utcnow()
    expires_at = now + timedelta(hours=24)

    # Use unique pseudo email to avoid conflicts with unique indexes.
    email = f"{username.lower()}@guest.invalid"
    pw_plain = secrets.token_urlsafe(24)

    doc = {
        'username': username,
        'email': email,
        'password_hash': generate_password_hash(pw_plain),
        'rating': rating,
        'games_played': 0,
        'wins': 0,
        'losses': 0,
        'draws': 0,
        'created_at': now,
        'is_active': True,
        'is_email_verified': False,
        'is_guest': True,
        'user_kind': 'guest',
        'legion': legion,
        'language': language,
        'expiresAt': expires_at,
    }

    r = db.users.insert_one(doc)
    inserted_id = getattr(r, 'inserted_id', None)
    if inserted_id is None and isinstance(r, dict):
        inserted_id = r.get('inserted_id')

    u = None
    try:
        if inserted_id is not None:
            u = db.users.find_one({'_id': inserted_id})
    except Exception:
        u = None

    if not u:
        u = dict(doc)
        if inserted_id is not None:
            u['_id'] = inserted_id

    token, profile, login_warning = _issue_login_payload(db, u)
    out = {'success': True, 'access_token': token, 'profile': profile, 'guest': True}
    if login_warning:
        out['login_warning'] = login_warning
    return jsonify(out), 200


@auth_bp.route('/google', methods=['POST'])
def google_login():
    """Sign in with Google (ID token) endpoint.
    - 既存ユーザー: google_sub または email でヒットしたらログイン
    - 新規ユーザー: プロフィール入力が必要として signup_token を返す
    """
    db = get_db()
    b = _json()
    idt = (b.get('id_token') or b.get('credential') or '').strip()
    language = _normalize_language(b.get('language') or b.get('lang') or b.get('locale'), default=None)
    if not idt:
        return _err('id_token_required', 'id_token は必須です', 400)

    try:
        info = _verify_google_id_token(idt)
    except Exception:
        return _err('google_token_verification_failed', 'Googleトークンの検証に失敗しました', 401)

    gsub = str(info.get('sub') or '')
    email = (info.get('email') or '').strip().lower() or None
    name = (info.get('name') or info.get('given_name') or '').strip() or None
    email_verified = bool(info.get('email_verified')) if 'email_verified' in info else None

    if not gsub:
        return _err('google_account_invalid', 'Googleアカウント情報が不正です', 401)

    u = db.users.find_one({'google_sub': gsub})
    if not u and email:
        u = db.users.find_one({'email': email})

    if u:
        # link google_sub if missing
        upd = {}
        if u.get('google_sub') != gsub:
            upd['google_sub'] = gsub
        if email and (u.get('email') or '').lower() != email:
            # normally email should match, but don't overwrite existing email unless empty
            if not u.get('email'):
                upd['email'] = email
        if email_verified is True:
            upd['is_email_verified'] = True
        if language is not None:
            upd['language'] = language
        if upd:
            db.users.update_one({'_id': u['_id']}, {'$set': upd})
            u.update(upd)

        token, profile, login_warning = _issue_login_payload(db, u)
        out = {'success': True, 'access_token': token, 'profile': profile}
        if login_warning:
            out['login_warning'] = login_warning
        return jsonify(out), 200

    signup_token = _make_google_signup_token(gsub, email, name)
    return jsonify({
        'success': False,
        'needs_profile': True,
        'signup_token': signup_token,
        'prefill': {'email': email, 'name': name},
    }), 200


@auth_bp.route('/google/complete', methods=['POST'])
def google_complete():
    """Google 新規登録: 表示名(username) と 初期レーティング を受け取ってユーザーを作成"""
    db = get_db()
    b = _json()
    st = (b.get('signup_token') or '').strip()
    username = (b.get('username') or '').strip()
    rating_raw = b.get('rating')
    language = _normalize_language(b.get('language') or b.get('lang') or b.get('locale'), default=None)

    if not st:
        return _err('signup_token_required', 'signup_token は必須です', 400)

    if rating_raw is None or rating_raw == '':
        return _err('rating_required', 'レーティングを指定してください', 400)

    try:
        payload = _decode_google_signup_token(st)
    except Exception:
        return _err('signup_token_invalid_or_expired', 'signup_token が不正か期限切れです', 401)

    gsub = str(payload.get('sub') or '')
    email = (payload.get('email') or '').strip().lower() or None
    name = (payload.get('name') or '').strip() or None

    ok_u, u_code, u_or_msg = _validate_username(username)
    if not ok_u:
        return _err(u_code, u_or_msg, 400)
    username = u_or_msg

    ok_r, r_code, r_or_msg = _validate_rating(rating_raw)
    if not ok_r:
        return _err(r_code, r_or_msg, 400)
    rating = r_or_msg

    legion = _normalize_legion(b.get('legion'))

    # If a user was created meanwhile, just login/link
    existing = db.users.find_one({'google_sub': gsub}) if gsub else None
    if not existing and email:
        existing = db.users.find_one({'email': email})

    if existing:
        upd = {}
        if gsub and existing.get('google_sub') != gsub:
            upd['google_sub'] = gsub
        if language is not None:
            upd['language'] = language
        if upd:
            db.users.update_one({'_id': existing['_id']}, {'$set': upd})
            existing.update(upd)
        token, profile, login_warning = _issue_login_payload(db, existing)
        out = {'success': True, 'access_token': token, 'profile': profile}
        if login_warning:
            out['login_warning'] = login_warning
        return jsonify(out), 200

    # uniqueness checks
    if db.users.find_one({'username': username}):
        return _err('username_taken', 'このユーザー名は既に使用されています', 400)
    if email and db.users.find_one({'email': email}):
        return _err('email_taken', 'このメールアドレスは既に使用されています', 400)

    doc = {
        'username': username,
        'email': email,
        'google_sub': gsub,
        'display_name': name or username,
        'password_hash': None,
        'rating': rating, 'games_played': 0, 'wins': 0, 'losses': 0, 'draws': 0,
        'created_at': datetime.utcnow(), 'is_active': True,
        'is_email_verified': True,
        'settings': DEFAULT_SETTINGS.copy(),
        'user_kind': 'human',
        'legion': legion,
        'language': _normalize_language(language, default='en') if language is not None else 'en',
    }
    r = db.users.insert_one(doc)
    doc['_id'] = r.inserted_id

    token, profile, login_warning = _issue_login_payload(db, doc)
    out = {'success': True, 'access_token': token, 'profile': profile}
    if login_warning:
        out['login_warning'] = login_warning
    return jsonify(out), 200


@auth_bp.route('/profile', methods=['GET'])
@jwt_required()
def profile_legacy():
    from src.routes.user import _build_profile_payload
    db = get_db()
    sub = get_jwt_identity()
    try:
        uid = ObjectId(sub)
    except Exception:
        return jsonify({'message': 'invalid identity'}), 400
    u = db.users.find_one({'_id': uid}, {'username': 1, 'rating': 1})
    if not u:
        return jsonify({'message': 'user not found'}), 404
    return jsonify(_build_profile_payload(u)), 200


# --- compatibility alias endpoints ---
@auth_bp.route('/token', methods=['POST'])
def token_alias():
    # Behaves like /login for compatibility
    return login()

@auth_bp.route('/refresh', methods=['POST'])
def refresh_alias():
    # No refresh-token model; tell client to re-login
    return jsonify({'message':'no refresh token'}), 401

@auth_bp.route('/refresh_token', methods=['POST'])
def refresh_token_alias():
    return jsonify({'message':'no refresh token'}), 401


@auth_bp.route('/rotate', methods=['POST'])
@jwt_required()
def rotate():
    """Access Tokenを現在の有効なトークンから再発行する。
    有効期限切れのトークンでは呼べない（401）。
    """
    sub = get_jwt_identity()
    new_token = create_access_token(identity=sub)
    return jsonify({'access_token': new_token}), 200