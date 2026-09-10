#!/usr/bin/env bash
# Verify the Google Maps key: is Places API (New) enabled, and which
# referrers does the key accept? Run after any change in Cloud Console.
#   ./check-key.sh [referer ...]
# The tracked source carries a placeholder on purpose, so reading it here only
# ever tested the string REPLACE_WITH… and reported everything blocked. Take the
# real key from config.local.json, or from the built embed it was injected into.
KEY=$(node -e "
const fs=require('fs');
const pick=(s)=>((s||'').match(/GOOGLE_MAPS_API_KEY\s*:\s*'([^']*)'/)||[])[1]||'';
const read=(f)=>{try{return fs.readFileSync(f,'utf8')}catch(e){return ''}};
let k='';
try{k=JSON.parse(read('config.local.json')||'{}').GOOGLE_MAPS_API_KEY||''}catch(e){}
for (const f of ['webflow/embed.html','webflow/embed-part2.html','src/webflow-embed.html']) {
  if (k && k.indexOf('REPLACE_')!==0) break;
  k=pick(read(f));
}
console.log(k.indexOf('REPLACE_')===0?'':k);
")
[ -z "$KEY" ] && { echo "No real key found. Put it in config.local.json (see config.example.json), or run 'node build.js' first."; exit 1; }
echo "key: ${KEY:0:12}…"
# The staging domain matters as much as the live one: it is where you test the
# embed before publishing, and a key restricted to upserve.com alone fails there
# with no visible error - the finder just quietly degrades to a plain text box.
REFS=("$@"); [ ${#REFS[@]} -eq 0 ] && REFS=("https://upserve.com/" "https://www.upserve.com/" "https://upserve.webflow.io/" "")
for REF in "${REFS[@]}"; do
  OUT=$(curl -s -X POST "https://places.googleapis.com/v1/places:autocomplete" \
    -H "Content-Type: application/json" -H "X-Goog-Api-Key: $KEY" \
    ${REF:+-H "Referer: $REF"} -d '{"input":"Shortys BBQ Miami"}')
  if echo "$OUT" | grep -q '"suggestions"'; then
    echo "  OK       ${REF:-<no referer>}"
  else
    echo "  BLOCKED  ${REF:-<no referer>}  ->  $(echo "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.error.status+": "+j.error.message.slice(0,120))}catch(e){console.log(d.slice(0,120))}})')"
  fi
done
