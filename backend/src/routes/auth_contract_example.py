# これは「厳密なアイデンティティ契約」を守る login 実装例です。
# 既存の auth 実装において create_access_token の identity を「str(user._id)」に統一してください。

from flask import Blueprint, request, current_app
from flask_jwt_extended import create_access_token
from werkzeug.security import check_password_hash
from bson import ObjectId

auth_bp = Blueprint('auth', __name__, url_prefix='/api/auth')

def _db():
    db = getattr(current_app, 'mongo_db', None) or current_app.config.get('MONGO_DB', None)
    if db is None:
        raise RuntimeError('database handle not found')
    return db

@auth_bp.route('/login', methods=['POST'])
def login():
    db = _db()
    body = request.get_json() or {}
    username = body.get('username', '')
    password = body.get('password', '')

    user = db.users.find_one({'username': username})
    if user is None or not check_password_hash(user['password_hash'], password):
        return {'message': 'invalid credentials'}, 401

    # ★ ここが重要: JWT の identity(sub) は「MongoDB users._id を文字列化したもの」
    access_token = create_access_token(identity=str(user['_id']), additional_claims={
        'username': user.get('username'),
        'rating': user.get('rating')
    })
    return {'access_token': access_token}, 200