python3 - <<'PY'
import json
from pathlib import Path
p=Path('native/sources.json'); pins=json.loads(p.read_text())
pins['perl-5.42.0.tar.gz']={'sha256':'e093ef184d7f9a1b9797e2465296f55510adb6dab8842b0c3ed53329663096dc','urls':['https://www.cpan.org/src/5.0/perl-5.42.0.tar.gz']}
pins['bash-5.3.tar.gz']={'sha256':'0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba','urls':['https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz']}
p.write_text(json.dumps(pins,indent=2)+'\n')
Path('third_party/SHA256SUMS').write_text(''.join(f'{p["sha256"]}  {n}\n' for n,p in sorted(pins.items())))
PY
cat > native/scripts/bootstrap-tools.sh <<'EOF'
#!/usr/bin/env bash
# Host-only build tools, already approved/pinned in DEPENDENCIES.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || exit 1
source scripts/env.sh
native/scripts/fetch-sources.sh --verify-only
mkdir -p "$TORS_TOOLS/native-build"
if [[ ! -x "$TORS_TOOLS/perl-install/bin/perl" ]]; then
    tar -xzf third_party/dist/perl-5.42.0.tar.gz -C "$TORS_TOOLS/native-build"
    (cd "$TORS_TOOLS/native-build/perl-5.42.0"
     sh Configure -des -Dprefix="$TORS_TOOLS/perl-install" -Dman1dir=none -Dman3dir=none
     "$TORS_TOOLS/make-install/bin/make" -j2
     "$TORS_TOOLS/make-install/bin/make" install)
fi
if [[ ! -x "$TORS_TOOLS/bash-install/bin/bash" ]]; then
    tar -xzf third_party/dist/bash-5.3.tar.gz -C "$TORS_TOOLS/native-build"
    (cd "$TORS_TOOLS/native-build/bash-5.3"
     ./configure --prefix="$TORS_TOOLS/bash-install" --without-bash-malloc --disable-nls
     "$TORS_TOOLS/make-install/bin/make" -j2
     "$TORS_TOOLS/make-install/bin/make" install)
fi
EOF
chmod +x native/scripts/bootstrap-tools.sh
cat > torcore/native/build.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Native builds run offbox only' >&2; exit 1; }
source scripts/env.sh
export PATH="$TORS_TOOLS/perl-install/bin:$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"
export CONFIG_SHELL="$TORS_TOOLS/bash-install/bin/bash"
[[ -x "$CONFIG_SHELL" ]] || { echo 'Run native/scripts/bootstrap-tools.sh first'; exit 1; }
if [[ ${TORS_PINNED_SHELL:-0} != 1 ]]; then
    export TORS_PINNED_SHELL=1
    exec "$CONFIG_SHELL" "$0" "$@"
fi
native/scripts/fetch-sources.sh --verify-only
[[ $(perl -e 'printf "%vd", $^V') == 5.42.0 ]] || exit 1
[[ $(cat "$ANDROID_NDK_HOME/source.properties") == *'29.0.14206865'* ]] || exit 1
root="$PWD"
make="$TORS_TOOLS/make-install/bin/make"
for abi in "${@:-arm64-v8a x86_64}"; do
    # Expand the default ABI list; explicit arguments are individual ABIs.
    for abi in $abi; do
        case "$abi" in
            arm64-v8a) triple=aarch64-linux-android; openssl_target=android-arm64 ;;
            x86_64) triple=x86_64-linux-android; openssl_target=android-x86_64 ;;
            *) echo "Unsupported ABI: $abi" >&2; exit 1 ;;
        esac
        prefix="$root/build/native-deps/$abi"
        work="$root/build/tor/$abi"
        mkdir -p "$prefix" "$work" "$root/torcore/build/native-libs/$abi"
        export CC="${triple}29-clang" AR=llvm-ar RANLIB=llvm-ranlib STRIP=llvm-strip
        export CFLAGS='-O2 -fPIC -fstack-protector-strong -ffunction-sections -fdata-sections'
        export CPPFLAGS='' LDFLAGS='-Wl,-z,relro,-z,now,-z,noexecstack,-z,max-page-size=16384 -Wl,--gc-sections'
        # Rebuild if any recipe, patch, or source pin changes; never trust a
        # partial prior install. The digest also scopes the reusable prefix.
        stamp=$(cat torcore/native/build.sh native/sources.json native/scripts/sources.py | sha256sum | cut -d' ' -f1)
        if [[ -f "$prefix/complete" && $(cat "$prefix/complete") == "$stamp" ]]; then
            echo "Native cache verified $abi $stamp"
            continue
        fi
        rm -rf "$work" "$prefix"
        mkdir -p "$work" "$prefix"
        for archive in openssl-3.5.9 libevent-2.1.13-stable zlib-1.4 tor-0.4.9.16; do
            tar -xzf "$root/third_party/dist/$archive.tar.gz" -C "$work"
        done
        (
            cd "$work/openssl-3.5.9"
            # Keep modern primitives (including Ed25519/X25519) for both Tor
            # and OpenSSH. No engines, DSO, loadable/legacy providers or CLI.
            unset CC  # Android Configure selects the NDK API-specific compiler.
            ./Configure "$openssl_target" -D__ANDROID_API__=29 \
                --prefix="$prefix/openssl" --libdir=lib no-shared no-tests no-docs \
                no-apps no-engine no-dso no-module no-legacy no-comp no-zlib \
                no-ssl3 no-tls1 no-tls1_1 no-weak-ssl-ciphers no-async \
                $CFLAGS $LDFLAGS
            "$make" -j2 build_libs
            "$make" install_dev
        ) > "$work/openssl.log" 2>&1
        (
            cd "$work/libevent-2.1.13-stable"
            ./configure --host="$triple" --prefix="$prefix/libevent" \
                --disable-shared --enable-static --with-pic --disable-openssl \
                --disable-samples --disable-libevent-regress --disable-doxygen-html
            "$make" -j2
            "$make" install
        ) > "$work/libevent.log" 2>&1
        (
            cd "$work/zlib-1.4"
            ./configure --static --prefix="$prefix/zlib"
            "$make" -j2 libz.a
            "$make" install
        ) > "$work/zlib.log" 2>&1
        (
            cd "$work/tor-0.4.9.16"
            flags=(--disable-module-relay --disable-asciidoc --disable-manpage \
                --disable-html-manual --disable-unittests --enable-pic \
                --enable-static-openssl --enable-static-libevent --enable-static-zlib \
                --disable-lzma --disable-zstd --disable-system-torrc --disable-tool-name-check)
            ./configure --help > "$work/tor-configure-help.txt"
            for flag in "${flags[@]}"; do
                # Autoconf often documents only the opposite enable/disable spelling.
                option=${flag#--enable-}; option=${option#--disable-}
                grep -Eq -- "--(enable|disable)-$option([ =]|$)" "$work/tor-configure-help.txt" || { echo "Unknown tor flag: $flag"; exit 1; }
            done
            export CFLAGS="$CFLAGS -fPIE" LDFLAGS="$LDFLAGS -pie"
            ./configure --host="$triple" --prefix="$prefix/tor" \
                --with-openssl-dir="$prefix/openssl" --with-libevent-dir="$prefix/libevent" \
                --with-zlib-dir="$prefix/zlib" "${flags[@]}"
            "$make" -j2 tor
            llvm-strip --strip-all src/app/tor
            install -m755 src/app/tor "$root/torcore/build/native-libs/$abi/libtorcore_tor.so"
        ) > "$work/tor.log" 2>&1
        echo "$stamp" > "$prefix/complete"
        echo "Built tor + static PIC dependencies: $abi"
    done
done
EOF
chmod +x torcore/native/build.sh
cat > native/cmake/OpenSSL.cmake <<'EOF'
# Link the same static PIC OpenSSL used by Tor. Call build.sh first.
# Override TORS_NATIVE_DEPS only for a relocated build output tree.
if(NOT DEFINED TORS_NATIVE_DEPS)
    get_filename_component(TORS_NATIVE_DEPS "${CMAKE_CURRENT_LIST_DIR}/../../build/native-deps" ABSOLUTE)
endif()
if(NOT ANDROID_ABI MATCHES "^(arm64-v8a|x86_64)$")
    message(FATAL_ERROR "TorSSH OpenSSL requires a supported ANDROID_ABI")
endif()
set(_tors_ssl "${TORS_NATIVE_DEPS}/${ANDROID_ABI}/openssl")
foreach(_lib crypto ssl)
    if(NOT EXISTS "${_tors_ssl}/lib/lib${_lib}.a")
        message(FATAL_ERROR "Run torcore/native/build.sh first: missing lib${_lib}.a")
    endif()
    add_library(torssh::${_lib} STATIC IMPORTED GLOBAL)
    set_target_properties(torssh::${_lib} PROPERTIES
        IMPORTED_LOCATION "${_tors_ssl}/lib/lib${_lib}.a"
        INTERFACE_INCLUDE_DIRECTORIES "${_tors_ssl}/include")
endforeach()
add_library(torssh::openssl INTERFACE IMPORTED GLOBAL)
set_target_properties(torssh::openssl PROPERTIES INTERFACE_LINK_LIBRARIES "torssh::ssl;torssh::crypto")
EOF