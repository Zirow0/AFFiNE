# AFFiNE desktop on NixOS

This repository is a Nix flake. It builds the desktop app from source and runs
it on the Electron provided by nixpkgs. The build includes the on-device AI
backend (local workspaces talk to your own AI providers, no server needed).

## Try it

```bash
nix run github:Zirow0/AFFiNE/claude/upbeat-lovelace-6dl78l
```

or from a checkout:

```bash
nix build .#affine
./result/bin/affine
```

## Install on NixOS (flake configuration)

```nix
# flake.nix of your system configuration
{
  inputs.affine.url = "github:Zirow0/AFFiNE/claude/upbeat-lovelace-6dl78l";

  outputs = { nixpkgs, affine, ... }: {
    nixosConfigurations.laptop = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        affine.nixosModules.default
        { programs.affine.enable = true; }
      ];
    };
  };
}
```

The module installs the app (`affine` command and a desktop entry) and enables
GNOME Keyring. The keyring is required: the desktop app stores AI provider keys
encrypted with Electron `safeStorage`, which on Linux uses the Secret Service.
On KDE with KWallet set `programs.affine.enableKeyring = false;`.

Alternatively, without the module:

```nix
environment.systemPackages = [ affine.packages.x86_64-linux.affine ];
services.gnome.gnome-keyring.enable = true;
```

Or with the overlay: `nixpkgs.overlays = [ affine.overlays.default ];` and then
`pkgs.affine`.

## Wayland

Set `NIXOS_OZONE_WL=1` (e.g. `environment.sessionVariables.NIXOS_OZONE_WL = "1";`)
to run natively on Wayland.

## Local AI with Ollama

```nix
services.ollama.enable = true;
```

Then in AFFiNE: open a local workspace → Settings → Integrations → AI BYOK →
Add key → provider OpenAI, "Use a custom API-compatible endpoint",
`http://localhost:11434/v1`, Chat Completions API, add your model and enable
"Chat & writing", "Actions" and "Structured output".

## Updating the hashes

`flake.nix` pins two fixed-output hashes:

- `cargoHash` — Rust crates from `Cargo.lock`
- `yarnHash` — npm packages from `yarn.lock` (Linux x64 + arm64)

After changing a lock file, replace the corresponding hash with
`lib.fakeHash`, run `nix build .#affine`, and copy the `got:` hash from the
error message.

## Notes

- Build takes a while (Rust native module + renderer bundle); about 8 GB of
  free disk space and 8 GB of RAM are recommended.
- `packages/backend/server` (AFFiNE Enterprise Edition license) is removed
  from the build sources; the desktop app does not use it.
