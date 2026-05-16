// Small re-export so the saver can import "os" without TS module-resolution
// gymnastics under commonjs+esModuleInterop=true.
import * as nodeOs from "os";
export const os = nodeOs;
