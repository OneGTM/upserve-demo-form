#!/usr/bin/env bash
# Verify the Google Maps key: is Places API (New) enabled, and which
# referrers does the key accept? Run after any change in Cloud Console.
#   ./check-key.sh [referer ...]
KEY=$(node -e "const s=require('fs').readFileSync('src/webflow-embed.html','utf8');console.log((s.match(/GOOGLE_MAPS_API_KEY\s*:\s*'([^']*)'/)||[])[1]||'')")
[ -z "$KEY" ] && { echo "No key found in src/webflow-embed.html"; exit 1; }
echo "key: ${KEY:0:12}…"
REFS=("$@"); [ ${#REFS[@]} -eq 0 ] && REFS=("https://upserve.com/" "https://www.upserve.com/" "")
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
