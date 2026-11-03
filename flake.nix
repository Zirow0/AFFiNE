{
  description = "AFFiNE desktop (fork with on-device AI) for NixOS";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

      # Only what the desktop build needs; skips build outputs, dependency
      # folders and local artifacts so they never end up in the Nix store.
      src = lib.cleanSourceWith {
        name = "affine-source";
        src = lib.cleanSource ./.;
        filter =
          path: type:
          let
            base = baseNameOf path;
            rel = lib.removePrefix (toString ./. + "/") (toString path);
          in
          !(
            (type == "directory"
              && lib.elem base [
                "node_modules"
                "target"
                "dist"
                "out"
                ".direnv"
                ".nx"
                ".electron_zip_dir"
              ])
            || lib.hasPrefix "packages/backend/server/static" rel
            || lib.hasPrefix "packages/frontend/apps/electron/resources/web-static" rel
            || lib.hasSuffix ".node" base
            || lib.hasPrefix "result" base
            || base == "flake.nix"
            || base == "flake.lock"
            || base == "nix"
          );
      };

      mkAffine =
        pkgs: args:
        pkgs.callPackage ./nix/affine-desktop.nix (
          {
            inherit src version;
            # update after changing Cargo.lock / yarn.lock (see nix/affine-desktop.nix)
            cargoHash = "sha256-iXcJ/3CfYHinbUrNJmpv0zaFp2u+ifgH17TB0HoGl5g=";
            yarnHash = "sha256-QxNj7UYpdgZNWh6NLBhPDDTyS+BUj2mxDqqIEqQZq3A=";
          }
          // args
        );
    in
    {
      packages = forAllSystems (pkgs: {
        affine = mkAffine pkgs { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.affine;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.affine;
        };
      });

      overlays.default = final: _prev: {
        affine = mkAffine final { };
      };

      # `imports = [ affine.nixosModules.default ];` then `programs.affine.enable = true;`
      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.programs.affine;
        in
        {
          options.programs.affine = {
            enable = lib.mkEnableOption "AFFiNE desktop with on-device AI";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.affine;
              defaultText = lib.literalExpression "affine.packages.\${system}.affine";
              description = "The AFFiNE package to install.";
            };
            enableKeyring = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = ''
                Enable GNOME Keyring so AFFiNE can store AI provider keys
                encrypted (Electron safeStorage). Disable if you already use
                KWallet or another Secret Service provider.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
            services.gnome.gnome-keyring.enable = lib.mkIf cfg.enableKeyring (lib.mkDefault true);
          };
        };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            cargo
            rustc
            rustfmt
            clippy
            pkg-config
            postgresql_16
            redis
          ];
        };
      });
    };
}
