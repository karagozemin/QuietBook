import { defaultDatabasePath } from "./config.js";
import { EvidenceDatabase } from "./db.js";
import { syncEvidenceStore } from "./sync.js";

const database = new EvidenceDatabase(process.env.QUIETBOOK_INDEXER_DB ?? defaultDatabasePath);
try {
  const result = await syncEvidenceStore(database);
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
