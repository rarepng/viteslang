# @postred/viteslang

plugin that imports and compiles [Slang](https://github.com/shader-slang/slang) shaders directly to viable wgsl/glsl for vite typescript.

supports lazy loading and destruct importing efficinetly.

## install

```bash
npm install -D @postred/viteslang
# or
pnpm add -D @postred/viteslang
# or
yarn add -D @postred/viteslang
```

`slangc` compiler installed and available in your system's PATH.*

## Setup

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { slangplugin } from '@postred/viteslang';

export default defineConfig({
  plugins: [slangplugin()]
});
```

### suggestions
this plugin automatically generates `.d.ts` files right next to the shader files. I suggest adding `*.slang.d.ts` to the `.gitignore`.
i also highly recommend using standard slang syntax with entry points that explicitly state the stage such as:
```c
[shader("vertex")]
void vxmain() { ... }

[shader("fragment")]
float4 pxmain() { ... }
```
if they are not provided the plugin defaults (falls back) to look for "main" function and assumes it's a fragment/pixel shader

## examples

### 1. static imports
all entry points are compiled but vite/rollup tree shakes the unimported ones then.

```typescript
import { vertexMain, fragmentMain } from './ui.slang?target=wgsl';

console.log(`compiling ${vertexMain.stage} to ${vertexMain.target}`);

const pipeline = device.createRenderPipeline({
  vertex: { 
    module: device.createShaderModule({ code: vertexMain.code }),
    entryPoint: vertexMain.name
  },
  // ...
});
```

### 2. lazy loading
using `?entry` parameter compiles only the desired entry from "ideally" a massive slang file.

```typescript
const heavyComputeModule = device.createShaderModule({
  label: 'big compute',
  code: await import('./big.slang?entry=randomizationPass&target=wgsl').then(m => m.randomizationPass.code)
});
```

### 3. dynamic and multi loading
You can request multiple specific shaders asynchronously in a single network request by comma-separating the entries.

```typescript
const loadPostProcessing = async () => {
if(condition){
    const { bloomFrag, blurFrag } = await import('./post.slang?entry=bloomFrag,blurFrag&target=wgsl');
    do stuff;
}else{
    const { bloomFrag, blurFrag } = await import('./post.slang?entry=flareFrag,pxlFrag&target=wgsl');
    do other stuff;
}
return {
    bloom: device.createShaderModule({ code: bloomFrag.code }),
    blur: device.createShaderModule({ code: blurFrag.code })
};
};
```

## Query Parameters

| Parameter | Options | Description |
| :--- | :--- | :--- |
| `target` | `wgsl` \| `glsl` | The compilation target. defaults to `glsl`. |
| `entry` | `string` | comma separated list of specific shader names to compile (e.g., `?entry=main,compute`). Omit to compile all shaders in the file. |

## under the hood

* it just fires `slangc` child processes in parallel.

## todo

* fix multi line entries reading/writing from/to the same types file like:
```typescript
import { vx } from './shader.slang?entry=vx';
import { fx } from './shader.slang?entry=fx';
```
* add second exported function for fetching (probably not building) slang (maybe wasm version for complete cross platformability) for users who dont have slang on path or maybe for everyone? (probably will switch wasm to default and slang on path to be optional for people who want latest slang)
