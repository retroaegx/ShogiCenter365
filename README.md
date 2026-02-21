# ShogiCenter365（ローカル構築手順）

このリポジトリは、将棋対局サイト（フロント + バックエンド + 解析エンジン連携）です。

- **フロント**: `frontend/shogi-frontend`（Vite + React）
- **バックエンド**: `backend/src`（Flask + Socket.IO）
- **解析サーバ**: `engine_server.py`（FastAPI / uvicorn。やねうら王 + NNUE を USI で呼び出し）
- **起動スクリプト**:
  - 開発: `dev.py`（既定: `http://localhost:5001`）
  - 本番: `serve_eventlet.py`（既定: `http://localhost:5000`）

---

## 0. 前提（必要なもの）

### OS 共通（最低限）
- Git
- Python **3.10+**（3.11/3.12 推奨）
- Node.js **18+**（20 推奨）
- MongoDB
- Redis

このREADMEは「Ubuntu で何も入ってないところから」でも迷わないように、**存在確認 → 無ければ入れる**の順で書きます。

### 0.1 Ubuntu で最初に入れておくもの（無い場合のみ）
（※ すでに入っているならスキップしてOK）

まず入っているか確認:
```bash
command -v git || echo "git not found"
command -v unzip || echo "unzip not found"
python3 --version || echo "python3 not found"
```

無ければインストール:
```bash
sudo apt update
sudo apt install -y \
  git curl unzip ca-certificates build-essential \
  python3 python3-venv python3-pip
```

### 0.2 Node.js / npm（18+推奨）と pnpm

まず入っているか確認:
```bash
node -v || echo "node not found"
npm -v || echo "npm not found"
```

- `node` が無い、またはバージョンが **18 未満**なら、Node.js を入れ直します。

例A) NodeSource で Node.js 20 を入れる（Ubuntu / Debian系の例）:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

例B) `nvm` を使う（任意。複数バージョンを切り替えたい場合）:
```bash
# nvm を入れたあと（nvm の README 手順に従う）
nvm install 20
nvm use 20
node -v
npm -v
```

#### pnpm の用意（corepack がある場合 / ない場合）
このフロントは `pnpm` を想定しています（`package.json` の `packageManager` 参照）。

corepack の有無:
```bash
command -v corepack && corepack --version || echo "corepack not found"
```

A) corepack がある場合:
```bash
corepack enable
corepack prepare pnpm@10.4.1 --activate
pnpm -v
```

B) corepack が無い場合:
```bash
npm i -g pnpm@10.4.1
pnpm -v
```

### 0.3 MongoDB / Redis（無い場合の入れ方）
まず存在確認（コマンドの有無 / サービス起動）:
```bash
# コマンド確認
mongod --version || echo "mongod not found"
redis-server --version || echo "redis-server not found"

# systemd サービス確認（Ubuntu）
systemctl status mongod --no-pager || true
systemctl status redis-server --no-pager || true
```

- すでに MongoDB / Redis が起動していればそのままで OK
- 無い場合は **A) Ubuntu に直接インストール** か **B) Docker で起動** のどちらかで用意してください

#### A) Ubuntu に直接インストールする（推奨: Redis は apt / MongoDB は公式リポジトリ）

##### Redis（Ubuntu 標準パッケージ）
```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server

# 動作確認
redis-cli ping   # -> PONG
```

##### MongoDB Community Edition（Ubuntu 22.04 / 24.04 の例）
MongoDB は Ubuntu 標準リポジトリ版が古い/非推奨なことがあるため、**公式リポジトリ**を使うのが安全です。

> 下の例は MongoDB 7.0 系。OS バージョンに合わせて `jammy`（22.04）/`noble`（24.04）を選んでください。

```bash
# 事前ツール
sudo apt update
sudo apt install -y gnupg curl ca-certificates

# 署名鍵を配置
curl -fsSL https://pgp.mongodb.com/server-7.0.asc   | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg

# Ubuntu 22.04 (jammy) の例
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse"   | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list >/dev/null

# Ubuntu 24.04 (noble) の場合は上の jammy を noble に変更

sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod

# 動作確認
mongosh --eval 'db.runCommand({ ping: 1 })'
```

うまく起動しない場合のログ確認:
```bash
sudo systemctl status mongod --no-pager
sudo journalctl -u mongod -n 100 --no-pager
sudo systemctl status redis-server --no-pager
sudo journalctl -u redis-server -n 100 --no-pager
```

#### B) Docker で起動する（ローカルに直接入れたくない場合）
Docker を使う場合は、後述の「5. MongoDB / Redis（ローカル）」の `docker run` 例だけでもOKです。
（データ永続化したいなら volume を付けてください）

---

## 1. ソースを取得（git clone）

配布ページ（`frontend/shogi-frontend/public/distribute.html`）に、ソースと素材のリンクが書いてあります。

クローン:
```bash
git clone https://github.com/retroaegx/ShogiCenter365.git
cd ShogiCenter365
```

（もし URL が違う構成で公開されている場合は、`distribute.html` の「Source」ボタンにある GitHub を優先してください）

---

## 2. 画像 / SVG / 効果音 / 盤面テーマ（無い前提で配置）

フロントは `frontend/shogi-frontend/public/` 配下の静的ファイルを直接参照します。

### 2.0 Git に含めない素材（.gitignore）
容量やライセンスの都合で、次の素材は **git 管理しません**（`.gitignore` 対象）。
クローン直後は README だけになるので、起動前に **別途用意して配置**してください。

- `frontend/shogi-frontend/src/assets/`（UI アイコン等。ビルド時 import 用）
- `frontend/shogi-frontend/public/sounds/`（効果音/環境音。`*.m4a` / `*.wav`）
- `frontend/shogi-frontend/public/country/`（旗 SVG。`*.svg`）
- `frontend/shogi-frontend/public/board-theme/images/`（盤面/駒画像）

それぞれのフォルダに README を置いてあります。
**必要ファイル名・置き方の詳細は各 README が正**です。

### 2.1 必須になりやすいパス
最低限、これが無いと見た目や一部 UI が壊れます。

- `frontend/shogi-frontend/public/shogi-assets/`
  - `site.css`
  - `static_shell.js`
  - `background.png`
  - `hero_logo.png`
- `frontend/shogi-frontend/public/country/`（言語/リージョン用の旗 SVG）
- `frontend/shogi-frontend/public/sounds/`（効果音）
- `frontend/shogi-frontend/public/board-theme/`（盤面・駒画像）

### 2.2 素材 ZIP から復元する方法
配布ページのリンク（または同梱されていれば `public/distribute/`）を使います。

#### A) `assets.zip`
- 配布URL: `http://sc365.f5.si/distribute/assets.zip`
- 同梱されている場合: `frontend/shogi-frontend/public/distribute/assets.zip`

展開先（public 直下に上書き展開）:
```bash
cd frontend/shogi-frontend
# 例: 同梱ZIPを使う場合
unzip -o public/distribute/assets.zip -d public
```

#### B) `board-theme.zip`
- 配布URL: `http://sc365.f5.si/distribute/board-theme.zip`
- 同梱されている場合: `frontend/shogi-frontend/public/distribute/board-theme.zip`

展開先（`public/board-theme/` を完成させる）:
```bash
cd frontend/shogi-frontend
unzip -o public/distribute/board-theme.zip -d public
```

`public/board-theme/config.json` が参照しているパス（例: `/board-theme/images/...`）が、ZIP 展開で揃っている状態がゴールです。

※ `board-theme.zip` にも `config.json` が入っているので、展開で **`public/board-theme/config.json` が上書き**されます。
- ZIP の `config.json` と画像をセットで使うなら、そのままで OK
- 既存の `config.json` を使い続けたい場合は、展開後に `config.json` を戻してください

---

## 3. 解析エンジン（やねうら王）と評価関数（NNUE）の配置

解析は **ローカルのバイナリ**を呼び出します。
`engine_server.py` は起動時に以下をチェックします。

- エンジン本体: `<project_root>/engine/YaneuraOu-by-gcc`（既定）
- NNUE: `<project_root>/engine/eval/nn.bin`（既定）

> 置き場所は `.env` の `DEV_YANEO_*` / `PROD_YANEO_*` で変更できます。

### 3.1 ディレクトリ作成
```bash
cd ShogiCenter365
mkdir -p engine/eval
```

### 3.2 やねうら王（エンジン本体）
- 配布ページのクレジットにあるソース: `https://github.com/yaneurao/YaneuraOu`

やること:
1. 自分の OS に合わせてビルド or バイナリ入手
2. 実行ファイルを **`engine/YaneuraOu-by-gcc`** という名前で置く（既定のまま使うなら）

例（既定名に合わせて配置）:
```bash
# できあがった実行ファイルをここに置く
cp /path/to/YaneuraOu-by-gcc ./engine/YaneuraOu-by-gcc
chmod +x ./engine/YaneuraOu-by-gcc
```

### 3.3 NNUE（評価関数）
- 配布ページのクレジットにあるソース: `https://github.com/yssaya/AobaNNUE`

やること:
1. `nn.bin` を入手
2. **`engine/eval/nn.bin`** に置く（既定のまま使うなら）

例:
```bash
cp /path/to/nn.bin ./engine/eval/nn.bin
```

---

## 4. 環境変数（.env）

ルートの `.env.template` をコピーして `.env` を作ります。

```bash
cd ShogiCenter365
cp .env.template .env
```

### 4.1 まず動かすだけ（開発）
開発は `DEV_*` に既定値が入っているので、
MongoDB/Redis がローカルで動いていれば最低限は起動します。

### 4.2 Google ログインを使う場合
`.env` の下の方にあるこれを設定します。

- `VITE_GOOGLE_CLIENT_ID=...`
- `GOOGLE_CLIENT_ID=...`（未設定なら `VITE_GOOGLE_CLIENT_ID` を参照する実装）

---

## 5. MongoDB / Redis（ローカル）

手元で動いていれば OK です。
Docker 例（任意）:

```bash
# MongoDB（永続化 volume 付きの例）
docker volume create shogi-mongo-data
docker run -d --name shogi-mongo   -p 27017:27017   -v shogi-mongo-data:/data/db   mongo:6

# Redis（永続化不要ならこのままでOK）
docker run -d --name shogi-redis -p 6379:6379 redis:7
```

起動確認:
```bash
docker ps --filter name=shogi-mongo --filter name=shogi-redis
# MongoDB（コンテナ内）
docker exec -it shogi-mongo mongosh --eval 'db.runCommand({ ping: 1 })'
# Redis（コンテナ内）
docker exec -it shogi-redis redis-cli ping   # -> PONG
```

---

## 6. Python（venv 作成 → 依存インストール → 起動）

### 6.1 venv
```bash
cd ShogiCenter365
python3 -m venv .venv

# 有効化（bash/zsh）
source .venv/bin/activate

python -m pip install --upgrade pip
```

### 6.2 Python 依存のインストール
**推奨**: ルート `requirements.txt` がある場合
```bash
pip install -r requirements.txt
```

もしルートに無い場合（分割構成のままの場合）:
```bash
pip install -r backend/requirements.txt
```

### 6.3 起動（開発）
```bash
cd ShogiCenter365
source .venv/bin/activate
python dev.py
```

- 既定: `http://localhost:5001`
- エンジンが未配置だと、解析サーバは起動に失敗します（サイト自体は起動しますが解析が効きません）。

### 6.4 起動（本番）
```bash
cd ShogiCenter365
source .venv/bin/activate
python serve_eventlet.py
```

- 既定: `http://localhost:5000`
- 本番は `.env` の `PROD_SECRET_KEY` / `PROD_JWT_SECRET_KEY` が必須です。

---

## 7. Frontend（インストール → build）

バックエンドは **Vite dev server にフォールバックしない**設計なので、
基本は `dist/` を作ってそこを配信します。

### 7.1 依存インストール
```bash
cd ShogiCenter365/frontend/shogi-frontend
pnpm install
```

### 7.2 build（指定された前提）
あなたの前提どおり、環境変数を付けて build します。

```bash
cd ShogiCenter365/frontend/shogi-frontend

VITE_GOOGLE_CLIENT_ID="xxxxxxxxxxxxxxxxxxxxxx" \
VITE_BUILD_ID="$(date +%Y%m%d%H%M%S)" \
pnpm build
```

build が終わると
- `frontend/shogi-frontend/dist/`

ができます。

---

## 8. 典型的な構築順（迷わない用）

```bash
# 1) clone
mkdir -p ~/work
cd ~/work
git clone https://github.com/retroaegx/ShogiCenter365.git
cd ShogiCenter365

# 2) .env
cp .env.template .env

# 3) assets（無い前提）
cd frontend/shogi-frontend
unzip -o public/distribute/assets.zip -d public
unzip -o public/distribute/board-theme.zip -d public
cd ../../

# 4) engine（無い前提）
mkdir -p engine/eval
# engine/YaneuraOu-by-gcc と engine/eval/nn.bin を配置

# 5) Mongo/Redis（動かす）
#   - ローカルで起動するか、docker で起動

# 6) venv + pip
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt  # 無ければ backend/requirements.txt

# 7) frontend build
cd frontend/shogi-frontend
pnpm install
VITE_GOOGLE_CLIENT_ID="xxxxxxxxxxxxxxxxxxxxxx" VITE_BUILD_ID="$(date +%Y%m%d%H%M%S)" pnpm build
cd ../../

# 8) サーバ起動（開発）
python dev.py
```

---

## 9. よくある失敗

### 9.1 `NNUE file not found` / `Engine binary not found`
- `engine/YaneuraOu-by-gcc` と `engine/eval/nn.bin` が無い、または名前/パスが違う。
- `.env` の `DEV_YANEO_ENGINE_*` / `DEV_YANEO_EVAL_DIR` を変えている。

### 9.2 盤面や駒が表示されない
- `public/board-theme/` が足りない。
- `public/board-theme/config.json` が参照している `images/boards` / `images/pieces` が存在しない。

### 9.3 `/shogi-assets/site.css` が 404
- `public/shogi-assets/` が足りない。
- `assets.zip` を `public/` に展開していない。

---

## 10. ライセンス / 素材クレジット

クレジットは `frontend/shogi-frontend/public/distribute.html` にまとめてあります。
再配布や公開をする場合は、そのページに書かれている条件（GPL 等）に従ってください。
