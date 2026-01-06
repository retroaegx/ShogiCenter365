# Register these blueprints in backend/src/main.py

```python
from routes.lobby_presence import presence_bp
from routes.lobby_online import online_bp

app.register_blueprint(presence_bp)
app.register_blueprint(online_bp)
```
Both blueprints use `current_app.mongo_db` so they read/write the exact same DB.