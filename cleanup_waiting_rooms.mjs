// Usage: mongosh <connection_string> cleanup_waiting_rooms.mjs
// Example: mongosh 'mongodb://localhost:27017/shogi_site_dev' cleanup_waiting_rooms.mjs

const dbname = db.getName();
print(`[cleanup] database = ${dbname}`);

// Delete waiting rooms that are missing creator snapshot or invalid creator_id/user.
const badIds = db.waiting_rooms.aggregate([
  { $match: { status: "waiting" } },
  { $lookup: {
      from: "users",
      localField: "creator_id",
      foreignField: "_id",
      as: "u"
  }},
  { $match: {
      $or: [
        { creator: { $exists: false } },
        { creator: null },
        { u: { $size: 0 } },
        { creator_id: { $exists: false } },
        { creator_id: null }
      ]
  }},
  { $project: { _id: 1 } }
]).toArray().map(d => d._id);

if (badIds.length) {
  const res = db.waiting_rooms.deleteMany({ _id: { $in: badIds } });
  print(`[cleanup] deleted ${res.deletedCount} invalid waiting_rooms`);
} else {
  print("[cleanup] no invalid waiting_rooms found");
}

// (任意) waiting で一定期間以上古い部屋を掃除したい場合は以下を有効化:
// const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000);
// const oldRes = db.waiting_rooms.deleteMany({ status: "waiting", created_at: { $lt: thirtyDaysAgo } });
// print(`[cleanup] deleted ${oldRes.deletedCount} old waiting_rooms`);
