{ fetchYarnDeps
, mkYarnPackage
}:

let
  manifest = builtins.fromJSON (builtins.readFile ./package.json);
in
mkYarnPackage rec {
  src = ./.;
  pname = "pnpm-lock-export";
  version = manifest.version;

  packageJSON = ./package.json;
  yarnLock = ./yarn.lock;
  offlineCache = fetchYarnDeps {
    inherit yarnLock;
    hash = "sha256-PcI4BrnEvS5wVIc7KtZ0T3qEe4PCD4sOE3nYabArq2Y=";
  };

  buildPhase = ''
    yarn --offline build
  '';

  postInstall = ''
    # Remove namespace prefix from executable
    mv "$out/bin/cvent-pnpm-lock-export" "$out/bin/pnpm-lock-export"
    chmod a+x "$out/bin/pnpm-lock-export"
  '';

  meta = {
    description = "Utility for converting pnpm-lock.yaml to other lockfile formats";
    homepage = "https://github.com/hallettj/pnpm-lock-export";
  };
}
