import os

# ワーカープロセスの数
workers = int(os.environ.get("GUNICORN_PROCESSES", "2"))

# スレッド数
threads = int(os.environ.get("GUNICORN_THREADS", "4"))

# タイムアウト（秒）
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "120"))

# バインドするアドレスとポート
bind = os.environ.get("GUNICORN_BIND", "0.0.0.0:5000")

# アプリケーションの場所
# chdir = '/path/to/your/shogi-complete/backend'

# WSGIアプリケーションの指定
# Gunicornを起動するディレクトリで `src.main:app` が解決される必要がある
# 例: `gunicorn --config gunicorn.conf.py src.main:app`

# ワーカークラス (eventletまたはgeventを使用)
worker_class = "eventlet"

# スティッキーセッション
# SocketIOでは、クライアントが同じサーバープロセスに接続し続けることが重要です。
# ロードバランサーを使用する場合、送信元IPアドレスに基づいてルーティングするなどの
# スティッキーセッション設定が必要です。
# Gunicorn自体にはスティッキーセッションの機能はありませんが、
# Nginxなどのリバースプロキシ側で `ip_hash` を使用して実現できます。

# ログ設定
accesslog = "-"  # 標準出力にアクセスログを出力
errorlog = "-"   # 標準出力にエラーログを出力
loglevel = "info" # ログレベル

# プロセス名
proc_name = "shogi-app"

# ホットリロード（開発用）
# reload = True

