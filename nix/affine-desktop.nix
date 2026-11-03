# AFFiNE desktop (Electron) built from this repository for NixOS.
#
# Based on the nixpkgs `affine` package (pkgs/by-name/af/affine/package.nix,
# MIT licensed), adapted to this fork: local sources, Yarn 4.18 from the
# repository, Electron 43 and the on-device AI backend.
#
# The two fixed-output hashes (`cargoHash`, `yarnHash`) depend on Cargo.lock
# and yarn.lock. After changing either lock file, set the hash to
# `lib.fakeHash`, build once and copy the hash Nix reports as "got:".
{
  lib,
  stdenv,
  stdenvNoCC,
  rustPlatform,
  electron_43,
  nodejs_22,
  cacert,
  writableTmpDirAsHomeHook,
  cargo,
  rustc,
  cmake,
  pkg-config,
  findutils,
  zip,
  jq,
  copyDesktopItems,
  makeWrapper,
  makeDesktopItem,

  src,
  version,
  buildType ? "stable",
  commandLineArgs ? "",
  cargoHash ? lib.fakeHash,
  yarnHash ? lib.fakeHash,
}:
let
  electron = electron_43;
  nodejs = nodejs_22;
  hostPlatform = stdenvNoCC.hostPlatform;
  nodePlatform = hostPlatform.node.platform;
  nodeArch = hostPlatform.node.arch;
  productName = if buildType != "stable" then "AFFiNE-${buildType}" else "AFFiNE";
  binName = lib.toLower productName;

  # The repository pins its own Yarn release (.yarnrc.yml `yarnPath`), so the
  # lockfile format always matches. Run it with Node directly.
  yarnCmd = "node $PWD/.yarn/releases/yarn-4.18.0.cjs";

  # electron-forge expects a zipped Electron distribution of the exact
  # version from yarn.lock; reuse the one from nixpkgs instead of downloading.
  electron-dist-zip = stdenvNoCC.mkDerivation {
    pname = "electron-dist-zip";
    version = electron.version;
    src = electron.dist;
    nativeBuildInputs = [ zip ];
    buildPhase = ''
      zip --recurse-paths - . > $out
    '';
    dontInstall = true;
  };

  # Proxy- and CA-related variables are passed to the fixed-output fetchers
  # so the build also works behind corporate proxies.
  impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [ "NODE_EXTRA_CA_CERTS" ];
in
stdenv.mkDerivation (finalAttrs: {
  pname = binName;
  inherit version src;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit (finalAttrs) pname version src;
    hash = cargoHash;
  };

  # All npm packages for Linux, downloaded once into a content-addressed cache.
  yarnOfflineCache = stdenvNoCC.mkDerivation {
    name = "${binName}-yarn-offline-cache-${version}";
    inherit src impureEnvVars;
    nativeBuildInputs = [
      nodejs
      cacert
      writableTmpDirAsHomeHook
    ];
    env.CI = "1";
    buildPhase =
      let
        supportedArchitectures = builtins.toJSON {
          os = [ "linux" ];
          cpu = [
            "x64"
            "arm64"
          ];
          libc = [ "glibc" ];
        };
      in
      ''
        runHook preBuild

        # trust the certificate bundle Nix provides to fixed-output builds
        if [ -n "''${NIX_SSL_CERT_FILE:-}" ] && [ -z "''${NODE_EXTRA_CA_CERTS:-}" ]; then
          export NODE_EXTRA_CA_CERTS="$NIX_SSL_CERT_FILE"
        fi

        mkdir -p $out/cache
        ${yarnCmd} config set enableTelemetry false
        ${yarnCmd} config set cacheFolder $out/cache
        ${yarnCmd} config set enableGlobalCache false
        ${yarnCmd} config set supportedArchitectures --json '${supportedArchitectures}'
        ${yarnCmd} install --immutable --mode=skip-build
        cp yarn.lock $out/yarn.lock

        runHook postBuild
      '';
    dontInstall = true;
    dontFixup = true;
    outputHashMode = "recursive";
    outputHash = yarnHash;
  };

  nativeBuildInputs = [
    nodejs
    cargo
    rustc
    # opus-codec builds libopus with CMake and generates bindings via bindgen
    cmake
    pkg-config
    rustPlatform.bindgenHook
    findutils
    zip
    jq
    writableTmpDirAsHomeHook
    copyDesktopItems
    makeWrapper
  ];

  # cmake is only a tool for a Rust build script here
  dontUseCmakeConfigure = true;

  env = {
    CI = "1";
    CARGO_NET_OFFLINE = "true";
    BUILD_TYPE = buildType;
    # embedded into the bundle as the build revision
    GITHUB_SHA = "ffffffffffffffffffffffffffffffffffffffff";
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };

  # The desktop app does not need the server. Its sources are under the
  # AFFiNE Enterprise Edition license, so they are dropped from the build;
  # package.json stays for the workspace lockfile check.
  postPatch = ''
    SERVER_PACKAGE_JSON="$(jq 'del(.scripts.postinstall)' packages/backend/server/package.json)"
    rm -rf packages/backend/server/{.*,*} 2>/dev/null || true
    echo "$SERVER_PACKAGE_JSON" > packages/backend/server/package.json
  '';

  configurePhase = ''
    runHook preConfigure

    # cargo: use the vendored crates
    mkdir -p .cargo
    cat $cargoDeps/.cargo/config.toml >> .cargo/config.toml
    ln -s $cargoDeps @vendor@

    # yarn: install from the offline cache only
    ${yarnCmd} config set enableTelemetry false
    ${yarnCmd} config set enableGlobalCache false
    ${yarnCmd} config set cacheFolder $yarnOfflineCache/cache
    ${yarnCmd} config set enableNetwork false

    # electron-forge: provide the Electron zip it would otherwise download
    export ELECTRON_FORGE_ELECTRON_ZIP_DIR=$PWD/.electron_zip_dir
    mkdir -p $ELECTRON_FORGE_ELECTRON_ZIP_DIR
    cp ${electron-dist-zip} \
      $ELECTRON_FORGE_ELECTRON_ZIP_DIR/electron-v${electron.version}-${nodePlatform}-${nodeArch}.zip

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    # 1. dependencies (husky hooks are irrelevant outside a git checkout)
    export HUSKY=0
    ${yarnCmd} install

    # 2. Rust native module (SQLite storage, indexer, ...)
    ${yarnCmd} affine @affine/native build

    # 3. renderer bundle + main/preload/helper layers
    ${yarnCmd} affine @affine/electron generate-assets

    # 4. re-install with an unhoisted node_modules layout for packaging
    ${yarnCmd} config set nmMode classic
    ${yarnCmd} config set nmHoistingLimits workspaces
    find . -name node_modules -type d -prune -exec rm -rf '{}' +
    ${yarnCmd} install

    # 5. package the app (no installers: Nix provides the Electron runtime)
    SKIP_WEB_BUILD=1 SKIP_BUNDLE=1 SKIP_GENERATE_ASSETS=1 HOIST_NODE_MODULES=1 \
      ${yarnCmd} affine @affine/electron package --platform=${nodePlatform} --arch=${nodeArch}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    out_dir=packages/frontend/apps/electron/out/${buildType}/${productName}-${nodePlatform}-${nodeArch}
    mkdir -p $out/lib/${binName}
    mv $out_dir/resources $out/lib/${binName}/
    cp $out_dir/LICENSE* $out/lib/${binName}/ 2>/dev/null || true

    for size in 64 128 256 512; do
      icon=packages/frontend/apps/electron/resources/icons/icon_${buildType}_''${size}x''${size}.png
      if [ -f "$icon" ]; then
        install -Dm644 "$icon" $out/share/icons/hicolor/''${size}x''${size}/apps/${binName}.png
      fi
    done

    makeWrapper "${lib.getExe electron}" $out/bin/${binName} \
      --inherit-argv0 \
      --add-flags $out/lib/${binName}/resources/app.asar \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}" \
      --add-flags ${lib.escapeShellArg commandLineArgs}

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = binName;
      desktopName = productName;
      comment = "AFFiNE Desktop App";
      exec = "${binName} %U";
      terminal = false;
      icon = binName;
      startupWMClass = binName;
      categories = [ "Utility" ];
      mimeTypes = [ "x-scheme-handler/${binName}" ];
    })
  ];

  meta = {
    description = "Workspace with fully merged docs, whiteboards and databases (fork with on-device AI)";
    homepage = "https://affine.pro/";
    license = lib.licenses.mit;
    mainProgram = binName;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    sourceProvenance = [ lib.sourceTypes.fromSource ];
  };
})
