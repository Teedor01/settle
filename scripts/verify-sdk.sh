set -u
cd "$(dirname "$0")/.."
echo "== versions (npm ls) =="
npm ls firebase @firebase/ai @firebase/app-check typescript vite 2>&1 | head -25
AI=node_modules/@firebase/ai
AC=node_modules/@firebase/app-check
if [ ! -d "$AI" ] || [ ! -d "$AC" ]; then
  echo "SDK NOT INSTALLED: missing $AI or $AC. Run npm install first. Nothing below was checked."
  exit 2
fi
show() { # label, dir, regex, lines of context after the match
  echo; echo "---- $1  [/$3/ in $2] ----"
  local out
  out=$(grep -rn --include='*.d.ts' -E -A"${4:-0}" "$3" "$2" 2>/dev/null | head -60)
  if [ -z "$out" ]; then echo "NOT FOUND (this symbol/shape is not declared as the code assumes)"; else echo "$out"; fi
}
echo; echo "== @firebase/ai declarations =="
show "getAI"                       "$AI" "function getAI\\b" 2
show "getGenerativeModel"          "$AI" "function getGenerativeModel\\b" 2
show "GoogleAIBackend"             "$AI" "class GoogleAIBackend\\b" 4
show "InferenceMode"               "$AI" "(const|type|enum) InferenceMode\\b" 8
show "HybridParams"                "$AI" "interface HybridParams\\b" 14
show "OnDeviceParams"              "$AI" "interface OnDeviceParams\\b" 14
show "LanguageModelCreateOptions"  "$AI" "interface LanguageModelCreateOptions\\b" 14
show "LanguageModelPromptOptions"  "$AI" "interface LanguageModelPromptOptions\\b" 14
show "LanguageModelMessage"        "$AI" "interface LanguageModelMessage\\b" 8
show "initializeDeviceModel"       "$AI" "initializeDeviceModel" 3
show "inferenceSource"             "$AI" "inferenceSource" 2
show "InferenceSource"             "$AI" "(const|type|enum) InferenceSource\\b" 6
show "ModelParams (systemInstruction?)" "$AI" "interface ModelParams\\b" 14
show "GenerationConfig (responseSchema)" "$AI" "interface GenerationConfig\\b" 30
show "SchemaRequest"               "$AI" "(type|interface) SchemaRequest\\b" 6
show "SchemaInterface"             "$AI" "interface SchemaInterface\\b" 40
echo; echo "== @firebase/app-check declarations =="
show "AppCheckOptions"             "$AC" "interface AppCheckOptions\\b" 12
show "CustomProvider"              "$AC" "class CustomProvider\\b" 6
show "CustomProviderOptions"       "$AC" "interface CustomProviderOptions\\b" 8
show "getToken"                    "$AC" "function getToken\\b" 2
show "AppCheckTokenResult"         "$AC" "interface AppCheckTokenResult\\b" 4
show "ReCaptchaEnterpriseProvider" "$AC" "class ReCaptchaEnterpriseProvider\\b" 4
echo; echo "== Phase 2: @firebase/auth and @firebase/firestore declarations =="
AU=node_modules/@firebase/auth
FS=node_modules/@firebase/firestore
if [ ! -d "$AU" ] || [ ! -d "$FS" ]; then
  echo "NOT INSTALLED: missing $AU or $FS. Nothing below was checked."
else
  show "getAuth"                        "$AU" "function getAuth\\b" 2
  show "createUserWithEmailAndPassword" "$AU" "function createUserWithEmailAndPassword\\b" 2
  show "signInWithEmailAndPassword"     "$AU" "function signInWithEmailAndPassword\\b" 2
  show "signOut"                        "$AU" "function signOut\\b" 2
  show "onAuthStateChanged"             "$AU" "function onAuthStateChanged\\b" 3
  show "getFirestore"                   "$FS" "function getFirestore\\b" 2
  show "runTransaction"                 "$FS" "function runTransaction\\b" 3
  show "documentId"                     "$FS" "function documentId\\b" 2
  show "startAfter"                     "$FS" "function startAfter\\b" 3
  show "orderBy"                        "$FS" "function orderBy\\b" 2
  show "setDoc (merge option)"          "$FS" "function setDoc\\b" 3
  show "serverTimestamp"                "$FS" "function serverTimestamp\\b" 2
fi
echo; echo "== done: send sdk-verify.txt together with the output of npm run typecheck =="
