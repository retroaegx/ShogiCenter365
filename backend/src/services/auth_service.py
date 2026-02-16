
import jwt
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
from werkzeug.security import generate_password_hash, check_password_hash
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
import os
import re
import smtplib
from email.mime.text import MIMEText
from email.header import Header
from flask_jwt_extended import create_access_token

class AuthService:
    def __init__(self, user_model, config):
        self.user_model = user_model
        self.config = config
        self.ph = PasswordHasher()
        self.PEPPER = os.getenv("PEPPER", "supersecretpepper") # 環境変数から取得、またはデフォルト値

    def _hash_password(self, password: str) -> str:
        """パスワードをargon2idでハッシュ化"""
        # argon2idはソルトを自動生成し、ハッシュに含める
        return self.ph.hash(password + self.PEPPER)

    def _verify_password(self, password: str, hashed_password: str) -> bool:
        """パスワードを検証"""
        try:
            self.ph.verify(hashed_password, password + self.PEPPER)
            return True
        except VerifyMismatchError:
            return False

    def _validate_email(self, email: str) -> Dict[str, Any]:
        """メールアドレスの形式を検証"""
        if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", email):
            return {"valid": False, "errors": ["無効なメールアドレス形式です"]}
        return {"valid": True}

    def _validate_password(self, password: str) -> Dict[str, Any]:
        """パスワードの強度を検証"""
        errors = []
        if len(password) < 8:
            errors.append("パスワードは8文字以上である必要があります")
        if not re.search(r'[A-Z]', password):
            errors.append("パスワードには少なくとも1つの大文字を含める必要があります")
        if not re.search(r'[a-z]', password):
            errors.append("パスワードには少なくとも1つの小文字を含める必要があります")
        if not re.search(r'[0-9]', password):
            errors.append("パスワードには少なくとも1つの数字を含める必要があります")
        strength = "Very Weak"
        if len(errors) == 0:
            strength = "Very Strong"
        elif len(errors) <= 1:
            strength = "Strong"
        elif len(errors) <= 2:
            strength = "Medium"
        else:
            strength = "Weak"

        return {"valid": not errors, "errors": errors, "strength": strength}

    def register_user(self, username: str, email: str, password: str) -> Dict[str, Any]:
        """ユーザー登録"""
        try:
            # ユーザー名とメールアドレスの重複チェック
            if self.user_model.get_user_by_username(username):
                return {"success": False, "message": "このユーザー名は既に使用されています"}
            if self.user_model.get_user_by_email(email):
                return {"success": False, "message": "このメールアドレスは既に使用されています"}

            # メールアドレスの形式検証
            email_validation = self._validate_email(email)
            if not email_validation["valid"]:
                return {"success": False, "message": email_validation["errors"][0]}

            # パスワードの強度検証
            password_validation = self._validate_password(password)
            if not password_validation["valid"]:
                return {"success": False, "message": password_validation["errors"][0]}

            # パスワードをハッシュ化
            hashed_password = self._hash_password(password)

            # メール検証トークン生成
            email_verification_token = self._generate_email_verification_token(email)

            # ユーザーデータ作成
            user_data = {
                "username": username,
                "email": email,
                "password_hash": hashed_password,
                "created_at": datetime.utcnow().isoformat(),
                "last_login_at": None,
                "is_active": True,
                "is_email_verified": False,
                "email_verification_token": email_verification_token,
                "email_verification_token_expires_at": (datetime.utcnow() + timedelta(hours=24)).isoformat()
            }

            user_id = self.user_model.create_user(user_data)

            if user_id:
                self._send_verification_email(email, email_verification_token)
                return {"success": True, "message": "ユーザー登録が完了しました。メールを確認してアカウントを有効化してください。"}
            else:
                return {"success": False, "message": "ユーザー登録に失敗しました"}
        except Exception as e:
            return {"success": False, "message": f"ユーザー登録中にエラーが発生しました: {str(e)}"}

    def login_user(self, identifier: str, password: str) -> Dict[str, Any]:
        """ユーザーログイン"""
        try:
            user = self.user_model.get_user_by_username_or_email(identifier)
            if not user:
                return {"success": False, "message": "ユーザー名またはパスワードが間違っています"}

            if not user.get("is_active", True):
                return {"success": False, "message": "アカウントが無効化されています"}

            if getattr(self.config, 'REQUIRE_EMAIL_VERIFICATION', True) and not user.get("is_email_verified", False):
                return {"success": False, "message": "メールアドレスが確認されていません。メールを確認してください。", "code": "email_unverified"}

            if self._verify_password(password, user["password_hash"]):
                # 最終ログイン日時を更新
                self.user_model.update_user(user["_id"], {"last_login_at": datetime.utcnow().isoformat()})
                # JWTトークン生成
                access_token = self._generate_jwt_token(str(user['_id']), user.get('username'))
                return {"success": True, "message": "ログイン成功", "access_token": access_token, "user_id": str(user["_id"]), "username": user["username"]}
            else:
                return {"success": False, "message": "ユーザー名またはパスワードが間違っています"}
        except Exception as e:
            return {"success": False, "message": f"ログイン中にエラーが発生しました: {str(e)}"}

    def _generate_jwt_token(self, user_id: str, username: str | None = None) -> str:
        """JWTトークンを生成（flask_jwt_extended を使用）"""
        claims = {"username": username} if username else None
        token = create_access_token(identity=str(user_id), additional_claims=claims)
        return token

    def get_user_profile(self, user_id: str) -> Dict[str, Any]:
        """ユーザープロフィール取得"""
        try:
            user = self.user_model.get_user_by_id(user_id)
            if user:
                # パスワードハッシュなどの機密情報は除外
                user_profile = {
                    "user_id": str(user["_id"]),
                    "username": user["username"],
                    "email": user["email"],
                    "created_at": user["created_at"],
                    "last_login_at": user["last_login_at"],
                    "is_active": user.get("is_active", True),
                    "is_email_verified": user.get("is_email_verified", False)
                }
                return {"success": True, "profile": user_profile}
            else:
                return {"success": False, "message": "ユーザーが見つかりません"}
        except Exception as e:
            return {"success": False, "message": f"プロフィール取得中にエラーが発生しました: {str(e)}"}

    def update_user_profile(self, user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """ユーザープロフィール更新"""
        try:
            filtered_data = {k: v for k, v in data.items() if k in ["username", "email"]}

            if "username" in filtered_data:
                username_validation = self._validate_username(filtered_data["username"])
                if not username_validation["valid"]:
                    return {"success": False, "message": username_validation["errors"][0]}

                existing_user = self.user_model.get_user_by_username(filtered_data["username"])
                if existing_user and existing_user["_id"] != user_id:
                    return {"success": False, "message": "このユーザー名は既に使用されています"}

            if "email" in filtered_data:
                email_validation = self._validate_email(filtered_data["email"])
                if not email_validation["valid"]:
                    return {"success": False, "message": email_validation["errors"][0]}

                existing_user = self.user_model.get_user_by_email(filtered_data["email"])
                if existing_user and existing_user["_id"] != user_id:
                    return {"success": False, "message": "このメールアドレスは既に使用されています"}

            success = self.user_model.update_user(user_id, filtered_data)

            if success:
                return {"success": True, "message": "プロフィールを更新しました"}
            else:
                return {"success": False, "message": "プロフィール更新に失敗しました"}

        except Exception as e:
            return {"success": False, "message": f"プロフィール更新中にエラーが発生しました: {str(e)}"}

    def change_password(self, user_id: str, current_password: str, new_password: str) -> Dict[str, Any]:
        """パスワード変更"""
        try:
            user = self.user_model.get_user_by_id(user_id)
            if not user:
                return {"success": False, "message": "ユーザーが見つかりません"}

            if not self._verify_password(current_password, user["password_hash"]):
                return {"success": False, "message": "現在のパスワードが正しくありません"}

            password_validation = self._validate_password(new_password)
            if not password_validation["valid"]:
                return {"success": False, "message": password_validation["errors"][0]}

            new_password_hash = self._hash_password(new_password)

            success = self.user_model.update_user(user_id, {
                "password_hash": new_password_hash,
                "password_changed_at": datetime.utcnow().isoformat()
            })

            if success:
                return {"success": True, "message": "パスワードを変更しました", "password_strength": password_validation["strength"]}
            else:
                return {"success": False, "message": "パスワード変更に失敗しました"}

        except Exception as e:
            return {"success": False, "message": f"パスワード変更中にエラーが発生しました: {str(e)}"}

    def _generate_email_verification_token(self, email: str) -> str:
        """メール検証トークンを生成"""
        payload = {
            "email": email,
            "exp": datetime.utcnow() + timedelta(hours=24) # 24時間で期限切れ
        }
        return jwt.encode(payload, self.config.SECRET_KEY, algorithm="HS256")

    def _send_verification_email(self, recipient_email: str, token: str):
        """検証メールを送信"""
        sender_email = os.getenv("SMTP_SENDER_EMAIL")
        sender_password = os.getenv("SMTP_SENDER_PASSWORD")
        smtp_server = os.getenv("SMTP_SERVER")
        smtp_port = int(os.getenv("SMTP_PORT", 587))

        if not all([sender_email, sender_password, smtp_server]):
            print("SMTP設定が不完全です。メール検証はスキップされます。")
            return

        verification_link = f"{self.config.FRONTEND_URL}/verify-email?token={token}"
        subject = "将棋アプリ - メールアドレスの確認"
        body = f"""
        将棋アプリにご登録いただきありがとうございます。
        以下のリンクをクリックして、メールアドレスを確認してください。

        {verification_link}

        このリンクは24時間で期限切れになります。
        """

        msg = MIMEText(body, 'plain', 'utf-8')
        msg['Subject'] = Header(subject, 'utf-8')
        msg['From'] = sender_email
        msg['To'] = recipient_email

        try:
            with smtplib.SMTP(smtp_server, smtp_port) as server:
                server.starttls()
                server.login(sender_email, sender_password)
                server.send_message(msg)
            print(f"検証メールを {recipient_email} に送信しました")
        except Exception as e:
            print(f"検証メールの送信中にエラーが発生しました: {e}")

    def verify_email(self, token: str) -> Dict[str, Any]:
        """メール検証トークンを検証し、ユーザーのメールアドレスを有効化"""
        try:
            payload = jwt.decode(token, self.config.SECRET_KEY, algorithms=["HS256"])
            email = payload.get("email")

            if not email:
                return {"success": False, "message": "無効なトークンです"}

            user = self.user_model.get_user_by_email(email)
            if not user:
                return {"success": False, "message": "ユーザーが見つかりません"}

            if user.get("is_email_verified"):
                return {"success": True, "message": "メールアドレスは既に検証済みです"}

            if datetime.utcnow().isoformat() > user.get("email_verification_token_expires_at", ''):
                return {"success": False, "message": "メール検証トークンの有効期限が切れています"}

            success = self.user_model.update_user(str(user["_id"]), {"is_email_verified": True, "email_verification_token": None, "email_verification_token_expires_at": None})

            if success:
                return {"success": True, "message": "メールアドレスが正常に検証されました"}
            else:
                return {"success": False, "message": "メールアドレスの検証に失敗しました"}

        except jwt.ExpiredSignatureError:
            return {"success": False, "message": "メール検証トークンの有効期限が切れています"}
        except jwt.InvalidTokenError:
            return {"success": False, "message": "無効なメール検証トークンです"}
        except Exception as e:
            return {"success": False, "message": f"メール検証中にエラーが発生しました: {str(e)}"}

    def validate_token(self, token: str) -> Dict[str, Any]:
        """トークンの検証 (JWTデコードはFlask-JWT-Extendedが自動で行うため、ここでは追加の検証ロジックを実装) """
        try:
            # Flask-JWT-Extendedがトークンをデコードし、有効性を確認済み
            # ここでは、ユーザーがアクティブであるか、メールが検証済みであるかなどの追加チェックを行うことができる
            # 現在のユーザーIDはJWTから取得されるため、ここではuser_idを引数として受け取る
            # user_id = get_jwt_identity() # Flask-JWT-Extendedを使用する場合
            # user = self.user_model.get_user_by_id(user_id)
            # if not user or not user.get("is_active") or not user.get("is_email_verified"):
            #     return {"success": False, "message": "無効なユーザーまたは未検証のアカウントです"}

            return {"success": True, "message": "トークンは有効です"}
        except Exception as e:
            return {"success": False, "message": f"トークン検証中にエラーが発生しました: {str(e)}"}

    def deactivate_user(self, user_id: str) -> Dict[str, Any]:
        """ユーザーアカウント無効化"""
        try:
            success = self.user_model.update_user(user_id, {
                "is_active": False,
                "deactivated_at": datetime.utcnow().isoformat()
            })

            if success:
                return {"success": True, "message": "アカウントを無効化しました"}
            else:
                return {"success": False, "message": "アカウント無効化に失敗しました"}

        except Exception as e:
            return {"success": False, "message": f"アカウント無効化中にエラーが発生しました: {str(e)}"}

    def reactivate_user(self, user_id: str) -> Dict[str, Any]:
        """ユーザーアカウント再有効化"""
        try:
            success = self.user_model.update_user(user_id, {
                "is_active": True,
                "reactivated_at": datetime.utcnow().isoformat()
            })

            if success:
                return {"success": True, "message": "アカウントを再有効化しました"}
            else:
                return {"success": False, "message": "アカウント再有効化に失敗しました"}

        except Exception as e:
            return {"success": False, "message": f"アカウント再有効化中にエラーが発生しました: {str(e)}"}

    def _validate_username(self, username: str) -> Dict[str, Any]:
        """ユーザー名の検証"""
        if not (3 <= len(username) <= 20):
            return {"valid": False, "errors": ["ユーザー名は3文字以上20文字以下である必要があります"]}
        if not re.match(r'^[a-zA-Z0-9_]+$', username):
            return {"valid": False, "errors": ["ユーザー名は英数字とアンダースコアのみ使用できます"]}
        return {"valid": True}



