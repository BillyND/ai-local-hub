import {spawnSync} from "node:child_process";
import {dirname,join} from "node:path";
import {cargoPath,manifest,rustBuildEnv} from "./native-build.mjs";
const run=(args)=>{
  const r=spawnSync(cargoPath(),["test",...args],{stdio:"inherit",env:rustBuildEnv()});
  if(r.error)throw r.error;
  if(r.status!==0)process.exit(r.status||1);
};
run(["--manifest-path",manifest]);
// Vendored oh-my-pi hashline engine: its own parity fixtures are the regression suite.
const vendor=join(dirname(dirname(manifest)),"vendor/omp");
run(["--manifest-path",join(vendor,"pi-edit/Cargo.toml"),"--target-dir",join(dirname(manifest),"target/omp-vendor")]);
