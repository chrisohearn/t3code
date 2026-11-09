// Executable builds load the existing staged dependency beside the running t3 binary.
const NodeModule = require("node:module");
module.exports = NodeModule.createRequire(process.execPath)("undici");
