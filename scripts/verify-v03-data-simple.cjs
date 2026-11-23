/**
 * 观澜 Guanlan v0.3 - 真实数据接入验证 (Node.js 版本)
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

async function main() {
  const workspaceRoot = 'C:/Users/34689/Downloads/拥抱AI';
  
  console.log('🎯 观澜 Guanlan v0.3 - 真实数据接入验证');
  console.log('=' .repeat(60));
  console.log(`📁 工作区根目录：${workspaceRoot}`);
  console.log();
  
  if (!fs.existsSync(workspaceRoot)) {
    console.error(`❌ 错误：找不到目录 ${workspaceRoot}`);
    process.exit(1);
  }
  
  try {
    console.log('🔍 开始扫描文件系统...');
    
    // 读取文件
    const files = {
      md: [],
      svg: [],
      pdf: []
    };
    
    await scanDirectory(workspaceRoot, '', files);
    
    console.log();
    console.log('✅ 扫描完成！');
    console.log('-'.repeat(60));
    console.log(`   Markdown (MD): ${files.md.length} 文件`);
    console.log(`   SVG 矢量图：${files.svg.length} 文件`);
    console.log(`   PDF 文档：${files.pdf.length} 文件`);
    console.log(`   总计：${files.md.length + files.svg.length + files.pdf.length} 文件`);
    console.log();
    
    // 显示示例
    console.log('📋 示例 MD 文件 (前 5 个):');
    console.log('-'.repeat(60));
    files.md.slice(0, 5).forEach((f, i) => {
      console.log(`${i+1}. ${f.name}`);
      console.log(`   📄 路径：${f.relativePath}`);
      console.log();
    });
    
    console.log('📋 示例 SVG 文件 (前 5 个):');
    console.log('-'.repeat(60));
    files.svg.slice(0, 5).forEach((f, i) => {
      console.log(`${i+1}. ${f.name}`);
      console.log(`   📄 路径：${f.relativePath}`);
      
      // 提取文字层
      try {
        const content = fs.readFileSync(f.fullPath, 'utf-8');
        const texts = extractSvgTexts(content);
        console.log(`   ✍️ 文字层：${texts.length} 处`);
        if (texts.length > 0) {
          console.log(`   💬 示例：${texts[0]}`);
        }
      } catch (e) {
        console.log(`   ⚠️ 读取失败`);
      }
      console.log();
    });
    
    console.log('📋 示例 PDF 文件 (前 5 个):');
    console.log('-'.repeat(60));
    files.pdf.slice(0, 5).forEach((f, i) => {
      console.log(`${i+1}. ${f.name}`);
      console.log(`   📄 路径：${f.relativePath}`);
      console.log(`   📊 大小：${(fs.statSync(f.fullPath).size / 1024 / 1024).toFixed(2)} MB`);
      console.log();
    });
    
    console.log('='.repeat(60));
    console.log('✨ 验证通过 - 真实数据已成功接入');
    console.log();
    
  } catch (error) {
    console.error('❌ 扫描失败:', error);
    process.exit(1);
  }
}

async function scanDirectory(dir, relativeDir, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.resolve(dir, entry.name);
    
    if (entry.isDirectory()) {
      // 跳过排除的目录
      if (['node_modules', '.git', '_软件安装包', '_spike'].includes(entry.name)) {
        continue;
      }
      
      const nextRelativeDir = relativeDir 
        ? `${relativeDir}/${entry.name}` 
        : entry.name;
      
      await scanDirectory(fullPath, nextRelativeDir, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      
      if (ext === '.md' || ext === '.markdown') {
        files.md.push({
          name: entry.name,
          fullPath,
          relativePath: relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        });
      } else if (ext === '.svg') {
        files.svg.push({
          name: entry.name,
          fullPath,
          relativePath: relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        });
      } else if (ext === '.pdf') {
        files.pdf.push({
          name: entry.name,
          fullPath,
          relativePath: relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        });
      }
    }
  }
}

function extractSvgTexts(svgContent) {
  const texts = [];
  const textRegex = /<text[^>]*>([^<]+)<\/text>/gi;
  let match;
  
  while ((match = textRegex.exec(svgContent)) !== null) {
    const text = match[1].trim();
    if (text.length > 0) {
      texts.push(text);
    }
  }
  
  return texts;
}

main();
