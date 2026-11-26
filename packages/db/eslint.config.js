import base from "@lomi/config/eslint";

export default [...base, { ignores: ["src/generated/**"] }];
