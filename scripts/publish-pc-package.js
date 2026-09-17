'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function publishPcPackage(stagingDirectory, repositoryDirectory = path.resolve(__dirname, '..')) {
  const repositoryRoot = path.resolve(repositoryDirectory);
  const stagingRoot = path.resolve(stagingDirectory);
  const packageJsonPath = path.join(repositoryRoot, 'package.json');
  const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid package version: ${String(version)}`);
  }

  const artifactName = `CodexRemote-Portable-${version}.exe`;
  const executableNames = fs.readdirSync(stagingRoot).filter((name) => /\.exe$/i.test(name));
  const sourceArtifact = path.join(stagingRoot, artifactName);

  if (executableNames.length !== 1 || executableNames[0] !== artifactName) {
    throw new Error(`Expected one non-empty portable executable named ${artifactName}.`);
  }

  const sourceStat = fs.lstatSync(sourceArtifact);
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`Expected one non-empty portable executable named ${artifactName}.`);
  }

  const outputDirectory = path.join(repositoryRoot, 'build', 'pc');
  const publishedArtifact = path.join(outputDirectory, artifactName);
  const temporaryArtifact = path.join(
    outputDirectory,
    `.${artifactName}.${crypto.randomUUID()}.tmp`
  );

  fs.mkdirSync(outputDirectory, { recursive: true });
  try {
    fs.copyFileSync(sourceArtifact, temporaryArtifact, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporaryArtifact, publishedArtifact);
  } catch (error) {
    try {
      fs.rmSync(temporaryArtifact, { force: true });
    } catch {
      // Preserve the publication error; cleanup is best effort.
    }
    throw error;
  }

  return { artifact: publishedArtifact };
}

if (require.main === module) {
  const stagingDirectory = process.argv[2];
  if (!stagingDirectory) {
    throw new Error('Usage: node publish-pc-package.js <staging-directory>');
  }

  const result = publishPcPackage(stagingDirectory);
  console.log(`Published PC package: ${result.artifact}`);
}

module.exports = { publishPcPackage };
