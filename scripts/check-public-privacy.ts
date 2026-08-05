import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoots = [join(root, "apps/web/src"), join(root, "docs/evidence")];
const readable = new Set([".css", ".html", ".json", ".md", ".ts", ".tsx"]);
const prohibitedKeys = new Set([
  "allowance",
  "controllerSk",
  "decrypted",
  "disclosedAmount",
  "ownerPostBalance",
  "privateBid",
  "recipientSecret",
  "remainingAllowance",
  "sk",
  "transferRandomness",
  "vTildeDisc",
]);

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((name) => {
    const item = join(path, name);
    return statSync(item).isDirectory() ? files(item) : readable.has(extname(item)) ? [item] : [];
  });
}

function collectPrivateValues(value: unknown, key = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectPrivateValues(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([childKey, item]) => collectPrivateValues(item, childKey));
  }
  if (typeof value !== "string") return [];
  if (/secret|(^|_)sk$|privateBid|controllerSk|recipientSecret|disclosedAmount/i.test(key)) {
    return value.length >= 8 ? [value, value.replace(/^0x/, "")] : [];
  }
  return [];
}

function jsonKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(prohibitedKeys.has(key) ? [`${path}.${key}`] : []),
    ...jsonKeys(item, `${path}.${key}`),
  ]);
}

const privateFiles = [
  ".quietbook/testnet-private.json",
  ".quietbook/testnet-smoke-private.json",
  ".quietbook/controller-smoke-private.json",
  ".quietbook/round-setup-private.json",
  ".quietbook/disclosure-private.json",
];
const privateValues = privateFiles.flatMap((path) => {
  const absolute = join(root, path);
  return existsSync(absolute) ? collectPrivateValues(JSON.parse(readFileSync(absolute, "utf8"))) : [];
});
const setupPath = join(root, ".quietbook/round-setup-private.json");
if (existsSync(setupPath)) {
  const setup = JSON.parse(readFileSync(setupPath, "utf8"));
  for (const bidder of setup.bidders ?? []) {
    if (bidder.delegation?.value) privateValues.push(String(bidder.delegation.value));
  }
}

const failures: string[] = [];
for (const path of publicRoots.flatMap(files)) {
  const content = readFileSync(path, "utf8");
  const name = relative(root, path);
  if (/\bS[A-Z2-7]{55}\b/.test(content)) failures.push(`${name}: Stellar secret seed`);
  for (const value of new Set(privateValues.filter((item) => item.length >= 8))) {
    const numeric = /^\d+$/.test(value);
    const pattern = numeric ? new RegExp(`(^|\\D)${value}(\\D|$)`) : null;
    if (pattern ? pattern.test(content) : content.includes(value)) failures.push(`${name}: private value match`);
  }
  if (extname(path) === ".json" && path.includes("docs/evidence/testnet/")) {
    for (const field of jsonKeys(JSON.parse(content))) failures.push(`${name}: prohibited field ${field}`);
  }
}

if (failures.length > 0) {
  throw new Error(`public privacy scan failed:\n${[...new Set(failures)].join("\n")}`);
}
console.log(`public privacy scan passed (${publicRoots.flatMap(files).length} files, ${new Set(privateValues).size} private values)`);
