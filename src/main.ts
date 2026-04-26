import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import type {Plugin} from 'vite';

const pfexec = promisify(execFile);

export function slangplugin(): Plugin {
  return {
    name: 'vite.slang.plugin',
    enforce: 'pre',

    async load(id: string) {
      const [filePath, query] = id.split('?');

      if (!filePath.endsWith('.slang')) return;

      const params = new URLSearchParams(query || '');

      const fallback = <T>(val: T, onFallback?: () => void): T => {
        onFallback?.();
        return val;
      };

      const entries = params.get('entry') ?
          params.get('entry')?.split(',').map(e => e.trim()) :
          null;

      const target = params.get('target') === 'wgsl' ?
          'wgsl' :
          params.get('target') === 'glsl' ?
          'glsl' :
          fallback(
              'glsl',
              () => console.warn(
                  '[viteslang] target was not provided defaulting to glsl\nto provide target use ?target=\navailable targets are wgsl and glsl'));

      try {
        const raw = await fs.readFile(filePath, 'utf-8');

        // ideal
        const entryRegex =
            /\[shader\("([^"]+)"\)]\s+(?:[\w<>]+\s+)?(\w+)\s*\(/g;
        let entryPoints: Array<{name: string, stage: string}> = [];
        let faulty: boolean = false;
        let match: RegExpExecArray|null;

        while ((match = entryRegex.exec(raw)) !== null) {
          entryPoints.push({stage: match[1], name: match[2]});
        }

        // another flimsy fallback
        if (entryPoints.length < 1) {
          entryPoints.push({
            stage: fallback(
                'fragment',
                () => {
                  console.error( // maybe throw the error instead?
                    `\n [viteslang] No entry points found in: ${filePath}\n` +
                    `You must explicitly tag your shader functions using the Slang attribute system.\n` +
                    `like:\n` +
                    `  [shader("vertex")]\n` +
                    `  void vxmain() { ... }\n`+
                    `or provide entry parameter.\n`+
                    `like:\n`+
                    `  ?entry=main`);
                  faulty = true;
                }),
            name: 'main'
          });  // todo
        }

        let mutableentryPoints: Array<{name: string, stage: string}> =
            entryPoints;

        if (entries) {
          mutableentryPoints =
              entryPoints.filter(e => entries.includes(e.name));
          const found = mutableentryPoints.map(e => e.name);
          const missing =
              entries.filter(requested => !found.includes(requested));

          if (missing.length > 0) {
            throw new Error(`[viteslang] Requested entries not found in ${
                filePath}: ${missing.join(', ')}`);
          }
        }

        const fileName = filePath.split(/[/\\]/).pop();
        const exactImportString =
            query ? `*/${fileName}?${query}` : `*/${fileName}`;

        const dtsPath = `${filePath}.d.ts`;
        let dtsContent = `// auto generated types file for viteslang\n`;
        dtsContent += `declare module "${exactImportString}" {\n`;
        mutableentryPoints.forEach(({name}) => {
          dtsContent += `export const ${
              name}: { readonly code: string; readonly target: "${
              target}"; readonly stage: string;readonly name: "${name}"; };\n`;
        });
        dtsContent += `}\n`;

        try {
          const existingDts = await fs.readFile(dtsPath, 'utf-8');
          if (existingDts !== dtsContent) {
            await fs.writeFile(dtsPath, dtsContent, 'utf-8');
          }
        } catch (e) {
          await fs.writeFile(dtsPath, dtsContent, 'utf-8');
        }

        const compilePromises = mutableentryPoints.map(async (entry) => {
          if (target === 'wgsl') {
            const args: Array<string> =
                [filePath, '-target', target, '-entry', entry.name];
            if (faulty) args.push('-stage', entry.stage);
            const {stdout: wgslCode} =
                await pfexec('slangc', args, {encoding: 'utf8'});

            // please help
            const CLEANUP_PATTERNS = [
              // wgsl
              'struct\\s+\\w+\\s*\\{[\\s\\S]*?\\};',
              '@(?:group|binding)[\\s\\S]*?;'
            ];

            const pattern = new RegExp(CLEANUP_PATTERNS.join('|'), 'g');
            const seen = new Set<string>();

            const code = wgslCode.replace(pattern, (match: string) => {
              const trim = match.replace(/\s+/g, ' ').trim();
              if (seen.has(trim)) return '';
              seen.add(trim);
              return match;
            });
            return {entry: entry.name, stage: entry.stage, code: code};
          } else {
            //
            //
            //
            //
            //    FUTURE REFERENCE
            //
            //
            //
            //
            // type compatibility =|{
            //   kind: 'vertex_id';
            //   stage: 'vertex';
            //   severity: 'lossy'
            // }
            // |{
            //   kind: 'instance_id';
            //   stage: 'vertex';
            //   severity: 'lossy'
            // }
            // |{
            //   kind: 'draw_index';
            //   stage: 'vertex';
            //   severity: 'unsupported'
            // }
            // |{
            //   kind: 'subgroup_ops';
            //   stage: string;
            //   severity: 'unsupported'
            // }
            // |{
            //   kind: 'tessellation';
            //   stage: string;
            //   severity: 'unsupported'
            // }
            // |{
            //   kind: 'geometry';
            //   stage: string;
            //   severity: 'unsupported'
            // }
            // |{
            //   kind: 'raytracing';
            //   stage: string;
            //   severity: 'unsupported'
            // }
            // |{
            //   kind: 'storage_buffer_rw';
            //   stage: string;
            //   severity: 'maybe'
            // };
            const tmpSpv =
                path.join(os.tmpdir(), `tmp_${Date.now()}_${entry.name}.spv`);
            try {
              const slangArgs = [
                filePath, '-target', 'spirv', '-profile', 'spirv_1_0', '-entry',
                entry.name, '-o', tmpSpv
              ];
              if (faulty) slangArgs.push('-stage', entry.stage);
              await pfexec('slangc', slangArgs);
              const {stdout: reflectionJson} =
                  await pfexec(`spirv-cross`, [tmpSpv, '--reflect']);
              const reflection = JSON.parse(reflectionJson);

              const renameArgs: Array<string> = [];
              if (reflection.inputs) {
                reflection.inputs.forEach((input: any) => {
                  if (input.name && !input.name.startsWith('gl_') &&
                      input.location !== undefined) {
                    renameArgs.push(
                        '--rename-interface-variable', 'in',
                        input.location.toString(), `v_match_${input.location}`);
                  }
                });
              }
              if (reflection.outputs) {
                reflection.outputs.forEach((output: any) => {
                  if (output.name && !output.name.startsWith('gl_') &&
                      output.location !== undefined) {
                    renameArgs.push(
                        '--rename-interface-variable', 'out',
                        output.location.toString(),
                        `v_match_${output.location}`);
                  }
                });
              }

              const xArgs: Array<string> = [
                tmpSpv, 
                "--version", "330", 
                "--extension", "GL_ARB_shader_draw_parameters",
                "--no-420pack-extension",
                ...renameArgs
              ];

              let {stdout: glslCode} = await pfexec("spirv-cross", xArgs, {encoding: 'utf8'});

              // X_X 🔫
              glslCode = glslCode.replace(/#version.*/, '#version 300 es\nprecision highp float;');
              glslCode = glslCode.replace(/#extension\s+GL_ARB_shader_draw_parameters.*?\n/g, '');
              glslCode = glslCode.replace(/\bgl_BaseVertexARB\b/g, '0')
                                 .replace(/\bgl_BaseInstanceARB\b/g, '0')
                                 .replace(/\bgl_BaseVertex\b/g, '0')
                                 .replace(/\bgl_BaseInstance\b/g, '0')
                                 .replace(/\bgl_VertexIndex\b/g, 'gl_VertexID')
                                 .replace(/\bgl_InstanceIndex\b/g, 'gl_InstanceID');
              glslCode = glslCode.replace(/binding\s*=\s*\d+\s*,\s*/g, '')
                                 .replace(/,\s*binding\s*=\s*\d+/g, '')
                                 .replace(/layout\s*\(\s*binding\s*=\s*\d+\s*\)\s*/g, '');

              return {entry: entry.name, stage: entry.stage, code: glslCode};
            } finally {
              await Promise.all([fs.rm(tmpSpv, {force: true}).catch(() => {})]);
            }
          }
        });

        const shaders = await Promise.all(compilePromises);

        let exits = ``;
        shaders.forEach(({entry, stage, code}) => {
          exits += `export const ${entry} = {
    name: "${entry}",
    code: ${JSON.stringify(code.trim())},
    target: "${target}",
    stage: "${stage}"
  };\n`;
        });

        return exits;


        // gotta do this properly and parse then separate different slang errors
        // x_x
      } catch (error: any) {
        console.error(`[viteslang] File: ${filePath}`);
        console.error(
            `[viteslang] ${error.stderr?.toString() || error.message}`);
        throw error;
      }
    }
  };
}