import {spawnSync} from "node:child_process";
import {cargoPath,manifest,rustBuildEnv} from "./native-build.mjs";
const r=spawnSync(cargoPath(),["test","--manifest-path",manifest],{stdio:"inherit",env:rustBuildEnv()});
if(r.error)throw r.error;
if(r.status!==0)process.exit(r.status||1);
