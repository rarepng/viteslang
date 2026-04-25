import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
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
                  '[vite-plugin-slang] target was not provided defaulting to glsl\nto provide target use ?target=\navailable targets are wgsl and glsl'));

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
                    `\n [vite-plugin-slang] No entry points found in: ${filePath}\n` +
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
            throw new Error(
                `[vite-plugin-slang] Requested entries not found in ${
                    filePath}: ${missing.join(', ')}`);
          }
        }

        const fileName = filePath.split(/[/\\]/).pop();
        const exactImportString =
            query ? `*/${fileName}?${query}` : `*/${fileName}`;

        const dtsPath = `${filePath}.d.ts`;
        let dtsContent = `// auto generated types file for vite-plugin-slang\n`;
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
          const args: Array<string> =
              [filePath, '-target', target, '-entry', entry.name];
          if (target === 'glsl') args.push('-profile', 'glsl_300_es');
          if (faulty) args.push('-stage', entry.stage);
          const {stdout} = await pfexec('slangc', args, {encoding: 'utf8'});

          // please help
          const CLEANUP_PATTERNS = [
            // wgsl
            'struct\\s+\\w+\\s*\\{[\\s\\S]*?\\};',
            '@(?:group|binding)[\\s\\S]*?;',

            // glsl
            'layout\\s*\\([\\s\\S]*?binding\\s*=\\s*\\d+[\\s\\S]*?\\)\\s*(?:uniform|buffer)\\s+\\w+\\s*\\{[\\s\\S]*?\\}(?:\\s*\\w+)?\\s*;',
            'layout\\s*\\([\\s\\S]*?binding\\s*=\\s*\\d+[\\s\\S]*?\\)\\s*uniform\\s+\\w+\\s+\\w+\\s*;'
          ];

          const pattern = new RegExp(CLEANUP_PATTERNS.join('|'), 'g');
          const seen = new Set<string>();

          const code = stdout.replace(pattern, (match: string) => {
            const trim = match.replace(/\s+/g, ' ').trim();
            if (seen.has(trim)) return '';
            seen.add(trim);
            return match;
          });
          return {entry: entry.name, stage: entry.stage, code: code};
        });

        const shaders = await Promise.all(compilePromises);

        let exits = ``;
        shaders.forEach(({entry, stage, code}) => {
          exits += `export const ${entry} = {
    name: "${entry}"
    code: ${JSON.stringify(code.trim())},
    target: "${target}",
    stage: "${stage}"
  };\n`;
        });

        return exits;


        // gotta do this properly and parse then separate different slang errors
        // x_x
      } catch (error: any) {
        console.error(`[vite-plugin-slang] File: ${filePath}`);
        console.error(
            `[vite-plugin-slang] ${error.stderr?.toString() || error.message}`);
        throw error;
      }
    }
  };
}