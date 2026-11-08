// Debug helper: node scenarios/get.ts <url> [--full]
// Fetches an ActivityPub document through the lab and prints it without the
// noisy @context and key material unless --full is given.
const [url, flag] = process.argv.slice(2);
if (!url) throw new Error("usage: node scenarios/get.ts <url> [--full]");
const response = await fetch(url, { headers: { accept: "application/activity+json" } });
const text = await response.text();
console.log(response.status, response.headers.get("content-type"));
try {
  const json = JSON.parse(text) as Record<string, unknown>;
  if (flag !== "--full") {
    delete json["@context"];
    delete json.assertionMethod;
    if (typeof json.publicKey === "object" && json.publicKey) json.publicKey = { ...json.publicKey, publicKeyPem: "..." };
  }
  console.log(JSON.stringify(json, null, 2));
} catch {
  console.log(text.slice(0, 2000));
}
