{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = { self, nixpkgs, systems }:
    let
      eachSystem = callback: nixpkgs.lib.genAttrs (import systems) (system: callback (pkgs system));
      pkgs = system: nixpkgs.legacyPackages.${system};
    in
    { 
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            nodejs
            nodePackages.pnpm
            typescript
          ];
        };
      });
    };

}
