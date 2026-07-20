import { Command } from 'commander';
import { DB } from '../../core/storage/database.js';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';

export const importCommand = new Command('import')
  .description('Import a ContextOS graph from a JSON file')
  .argument('<infile>', 'Input JSON file path')
  .action(async (infile: string) => {
    const db = new DB();
    const spinner = ora('Importing graph data...').start();

    try {
      const inPath = path.resolve(process.cwd(), infile);
      if (!fs.existsSync(inPath)) {
        throw new Error(`File not found: ${infile}`);
      }

      const fileData = fs.readFileSync(inPath, 'utf8');
      const importData = JSON.parse(fileData);

      if (!importData.data || !importData.data.chunks) {
        throw new Error('Invalid export format');
      }

      const dbInstance = db.getInstance();

      dbInstance.transaction(() => {
        // Insert Files
        const insertFile = dbInstance.prepare(`
          INSERT INTO files (
            path, layer, workspace_name, hash, last_indexed, importance, chunk_count
          ) VALUES (
            @path, @layer, @workspace_name, @hash, @last_indexed, @importance, @chunk_count
          ) ON CONFLICT(path) DO UPDATE SET
            layer = excluded.layer,
            workspace_name = excluded.workspace_name,
            hash = excluded.hash,
            last_indexed = excluded.last_indexed,
            importance = excluded.importance,
            chunk_count = excluded.chunk_count
        `);
        for (const file of importData.data.files) {
          insertFile.run(file);
        }

        // Insert Chunks
        const insertChunk = dbInstance.prepare(`
          INSERT INTO chunks (
            id, source_file, layer, workspace_name, section_title, section_depth,
            content, summary, keywords, hash, importance, token_count,
            file_type, language, symbol_name, symbol_kind,
            created_at, updated_at
          ) VALUES (
            @id, @source_file, @layer, @workspace_name, @section_title, @section_depth,
            @content, @summary, @keywords, @hash, @importance, @token_count,
            @file_type, @language, @symbol_name, @symbol_kind,
            @created_at, @updated_at
          ) ON CONFLICT(id) DO UPDATE SET
            source_file = excluded.source_file,
            layer = excluded.layer,
            workspace_name = excluded.workspace_name,
            section_title = excluded.section_title,
            section_depth = excluded.section_depth,
            content = excluded.content,
            summary = excluded.summary,
            keywords = excluded.keywords,
            hash = excluded.hash,
            importance = excluded.importance,
            token_count = excluded.token_count,
            file_type = excluded.file_type,
            language = excluded.language,
            symbol_name = excluded.symbol_name,
            symbol_kind = excluded.symbol_kind,
            updated_at = excluded.updated_at
        `);
        for (const chunk of importData.data.chunks) {
          insertChunk.run(chunk);
        }

        // Insert Relationships
        const insertRel = dbInstance.prepare(`
          INSERT INTO relationships (
            source, target, relationship_type, weight, source_chunk_id, layer, created_at
          ) VALUES (
            @source, @target, @relationship_type, @weight, @source_chunk_id, @layer, @created_at
          ) ON CONFLICT(source, target, relationship_type) DO UPDATE SET
            weight = excluded.weight,
            source_chunk_id = excluded.source_chunk_id,
            layer = excluded.layer
        `);
        for (const rel of importData.data.relationships) {
          insertRel.run(rel);
        }
      })();

      spinner.succeed(
        `Imported ${importData.data.chunks.length} chunks, ${importData.data.relationships.length} relationships, and ${importData.data.files.length} files from ${chalk.green(infile)}`
      );
    } catch (e: any) {
      spinner.fail(`Import failed: ${e.message}`);
    }
  });
