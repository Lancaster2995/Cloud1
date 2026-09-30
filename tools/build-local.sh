#!/usr/bin/env bash
# Builds the APK without the Android SDK / Gradle plugin, using only artifacts from Maven
# Central and npm (useful where dl.google.com is not reachable). The normal build is
# `./gradlew assembleRelease` (see .github/workflows/android.yml).
#
#   tools/build-local.sh            -> dist/Relevo.apk
#
# Tools are cached in $RELEVO_TOOLS (default: .tools/).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${RELEVO_TOOLS:-$ROOT/.tools}"
OUT="$ROOT/build-local"
APP="$ROOT/app"
MAVEN="https://repo.maven.apache.org/maven2"

VERSION_CODE=$(sed -n 's/.*versionCode *= *\([0-9]*\).*/\1/p' "$APP/build.gradle" | head -1)
VERSION_NAME=$(sed -n 's/.*versionName *= *"\([^"]*\)".*/\1/p' "$APP/build.gradle" | head -1)
MIN_SDK=$(sed -n 's/.*minSdk *= *\([0-9]*\).*/\1/p' "$APP/build.gradle" | head -1)
TARGET_SDK=$(sed -n 's/.*targetSdk *= *\([0-9]*\).*/\1/p' "$APP/build.gradle" | head -1)
PACKAGE=$(sed -n 's/.*applicationId *= *"\([^"]*\)".*/\1/p' "$APP/build.gradle" | head -1)

mkdir -p "$TOOLS"

fetch() { # url dest
    [ -s "$2" ] || { echo "· descargando $(basename "$2")"; curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"; }
}

# aapt2 + framework resources (bundled in apktool).
if [ ! -x "$TOOLS/aapt2" ] || [ ! -s "$TOOLS/android-framework.jar" ]; then
    fetch "$MAVEN/org/apktool/apktool-lib/3.0.3/apktool-lib-3.0.3.jar" "$TOOLS/apktool-lib.jar"
    (cd "$TOOLS" && unzip -o -q -j apktool-lib.jar prebuilt/linux/aapt2 prebuilt/android-framework.jar)
    chmod +x "$TOOLS/aapt2"
fi
# Android API classes to compile against.
fetch "$MAVEN/org/robolectric/android-all/15-robolectric-12650502/android-all-15-robolectric-12650502.jar" "$TOOLS/android-all.jar"
# APK signer.
fetch "$MAVEN/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar" "$TOOLS/apksig.jar"
# D8 dexer: the npm package ships it as dex; convert it back to JVM bytecode with dex2jar.
if [ ! -s "$TOOLS/d8-jvm.jar" ]; then
    fetch "https://registry.npmjs.org/d8-termux/-/d8-termux-1.0.0.tgz" "$TOOLS/d8-termux.tgz"
    (cd "$TOOLS" && tar xzf d8-termux.tgz package/d8.jar && mv package/d8.jar d8-dex.jar && rmdir package)
    mkdir -p "$TOOLS/dex2jar"
    for a in dex-tools dex-translator dex-reader dex-reader-api dex-ir d2j-base-cmd; do
        fetch "$MAVEN/de/femtopedia/dex2jar/$a/2.4.38/$a-2.4.38.jar" "$TOOLS/dex2jar/$a.jar"
    done
    for a in asm asm-tree asm-util asm-analysis asm-commons; do
        fetch "$MAVEN/org/ow2/asm/$a/9.10.1/$a-9.10.1.jar" "$TOOLS/dex2jar/$a.jar"
    done
    java -cp "$TOOLS/dex2jar/*" com.googlecode.dex2jar.tools.Dex2jarCmd -f -o "$TOOLS/d8-raw.jar" "$TOOLS/d8-dex.jar"
    java -cp "$TOOLS/dex2jar/*" "$ROOT/tools/D8Fix.java" "$TOOLS/d8-raw.jar" "$TOOLS/d8-jvm.jar"
    rm -rf "$TOOLS/d8patch" && mkdir -p "$TOOLS/d8patch"
    javac -nowarn --release 8 -cp "$TOOLS/d8-jvm.jar" -d "$TOOLS/d8patch" \
        "$ROOT/tools/d8patch/com/android/tools/r8/utils/ThreadUtils.java"
    (cd "$TOOLS/d8patch" && jar uf "$TOOLS/d8-jvm.jar" com/android/tools/r8/utils/ThreadUtils.class)
fi
# The converted D8 has no stack maps (verification off) and a few methods whose bytecode the
# GC cannot map, so it runs with a no-op collector and a heap big enough for this small app.
D8=(java -Xms3g -Xmx3g -XX:+UnlockExperimentalVMOptions -XX:+UseEpsilonGC
    -XX:+UnlockDiagnosticVMOptions -XX:-BytecodeVerificationRemote -XX:-BytecodeVerificationLocal
    -cp "$TOOLS/d8-jvm.jar" com.android.tools.r8.D8)

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "· recursos"
"$TOOLS/aapt2" compile --dir "$APP/src/main/res" -o "$OUT/res.zip"
sed "s#<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">#<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\" package=\"$PACKAGE\">#" \
    "$APP/src/main/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$TOOLS/aapt2" link -o "$OUT/base.apk" -I "$TOOLS/android-framework.jar" \
    --manifest "$OUT/AndroidManifest.xml" --java "$OUT/gen" \
    --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
    --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
    "$OUT/res.zip"

echo "· compilando Java"
find "$APP/src/main/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -nowarn -encoding UTF-8 --release 8 -cp "$TOOLS/android-all.jar" -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 \
    | grep -v -e 'JAVA_TOOL_OPTIONS' -e 'deprecat' -e 'Note:' -e 'warning: \[options\]' -e '^1 warning' || true
[ -f "$OUT/classes/io/github/lancaster2995/relevo/MainActivity.class" ] || { echo "javac falló"; exit 1; }
(cd "$OUT/classes" && jar cf "$OUT/classes-raw.jar" .)
java -cp "$TOOLS/dex2jar/*" "$ROOT/tools/D8Fix.java" --strip-params "$OUT/classes-raw.jar" "$OUT/classes.jar" >/dev/null

echo "· dex"
"${D8[@]}" --release --min-api "$MIN_SDK" --output "$OUT/dex" "$OUT/classes.jar" 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
[ -s "$OUT/dex/classes.dex" ] || { echo "d8 falló"; exit 1; }
(cd "$OUT/dex" && zip -q -X "$OUT/base.apk" classes.dex)

echo "· firmando"
java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED \
    --add-exports java.base/sun.security.util=ALL-UNNAMED -cp "$TOOLS/apksig.jar" "$ROOT/tools/ApkSign.java" "$APP/relevo.keystore" relevo-sideload relevo \
    "$OUT/base.apk" "$OUT/Relevo.apk" 2>&1 | grep -v JAVA_TOOL_OPTIONS
mkdir -p "$ROOT/dist"
cp "$OUT/Relevo.apk" "$ROOT/dist/Relevo.apk"
echo "APK: dist/Relevo.apk ($(du -h "$ROOT/dist/Relevo.apk" | cut -f1)) · v$VERSION_NAME ($VERSION_CODE)"
