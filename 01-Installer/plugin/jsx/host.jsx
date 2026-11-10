/* global app, File, Folder, ImportOptions, ImportAsType, CompItem, FootageItem */

// CEP/ExtendScript versions differ in JSON support, and some bridge calls can
// arrive with the JSON string encoded one extra time. Normalize both cases in
// one place before the import/replace handlers inspect the payload.
function afm_parsePayload(value) {
  var parsed = value;
  var attempts = 0;
  while (typeof parsed === "string" && attempts < 3) {
    attempts += 1;
    try {
      if (typeof JSON !== "undefined" && JSON && typeof JSON.parse === "function") {
        parsed = JSON.parse(parsed);
      } else {
        parsed = eval("(" + parsed + ")");
      }
    } catch (jsonError) {
      try {
        parsed = eval("(" + parsed + ")");
      } catch (evalError) {
        throw jsonError;
      }
    }
  }
  return parsed;
}

function afm_importFiles(jsonPayload) {
  var imported = 0;
  var failed = [];
  var payload;
  var paths;
  var sequence;
  var asComp;
  var asLayer;
  var targetComp = null;
  var importedItems = [];

  try {
    payload = afm_parsePayload(jsonPayload);
  } catch (err) {
    return "ERROR: 无法解析导入参数";
  }

  if (payload instanceof Array) {
    paths = payload;
    sequence = false;
    asComp = false;
    asLayer = false;
  } else {
    paths = payload.paths || [];
    sequence = !!payload.sequence;
    asComp = !!payload.asComp;
    asLayer = !!payload.asLayer;
  }

  if (!paths.length) {
    return "ERROR: 没有可导入的文件";
  }

  if (asLayer) {
    targetComp = afm_getTargetComp();
    if (!(targetComp instanceof CompItem)) {
      return "ERROR: 请先在 AE 中打开或选中一个合成，再导入图层";
    }
    if (targetComp.time >= targetComp.duration) {
      return "ERROR: 当前时间指针已在合成结尾，请移到合成范围内再导入图层";
    }
  }

  app.beginUndoGroup(asLayer ? "AE File Manager Import Layers" : (asComp ? "AE File Manager Import Composition" : "AE File Manager Import"));
  for (var i = 0; i < paths.length; i += 1) {
    var file = new File(paths[i]);
    if (!file.exists) {
      failed.push(paths[i]);
      continue;
    }

    try {
      var options = new ImportOptions(file);
      if (sequence && options.sequence !== undefined) {
        options.sequence = true;
      }
      if (asComp && options.canImportAs && typeof ImportAsType !== "undefined") {
        if (options.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)) {
          options.importAs = ImportAsType.COMP_CROPPED_LAYERS;
        } else if (options.canImportAs(ImportAsType.COMP)) {
          options.importAs = ImportAsType.COMP;
        }
      }
      var importedItem = app.project.importFile(options);
      if (importedItem) {
        importedItems.push(importedItem);
      }
      if (asLayer && importedItem) {
        var addedLayer = targetComp.layers.add(importedItem);
        afm_placeImportedLayer(addedLayer, targetComp);
      }
      imported += 1;
    } catch (err2) {
      failed.push(paths[i]);
    }
  }
  app.endUndoGroup();
  afm_selectProjectItems(importedItems);

  if (failed.length) {
    return "OK: 已导入 " + imported + " 个，失败 " + failed.length + " 个";
  }
  if (asLayer) {
    return "OK: 已导入并添加到当前合成 " + imported + " 个素材";
  }
  if (asComp) {
    return "OK: 已按合成方式导入 " + imported + " 个文件";
  }
  return sequence ? "OK: 已按序列导入 " + imported + " 组素材" : "OK: 已导入 " + imported + " 个文件";
}

// Places a newly imported layer at the playhead and fits it inside the active comp.
function afm_placeImportedLayer(layer, comp) {
  if (!layer || !(comp instanceof CompItem)) {
    return;
  }

  var source = layer.source;
  var sourceWidth = source && Number(source.width);
  var sourceHeight = source && Number(source.height);
  var currentTime = Number(comp.time);
  var sourceDuration = source && Number(source.duration);
  var layerDuration;
  var fitScale;
  var scaleValue;

  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    return;
  }

  if (!(currentTime >= 0)) {
    currentTime = 0;
  }
  if (currentTime > comp.duration) {
    currentTime = comp.duration;
  }

  fitScale = Math.min(comp.width / sourceWidth, comp.height / sourceHeight) * 100;
  scaleValue = layer.scale.value;
  if (scaleValue && scaleValue.length >= 3) {
    layer.scale.setValue([fitScale, fitScale, scaleValue[2]]);
  } else {
    layer.scale.setValue([fitScale, fitScale]);
  }
  layer.position.setValue([comp.width / 2, comp.height / 2]);

  layerDuration = sourceDuration;
  if (!(layerDuration > 0)) {
    layerDuration = layer.outPoint - layer.inPoint;
  }
  if (!(layerDuration > 0)) {
    layerDuration = comp.frameDuration;
  }

  layer.startTime = currentTime;
  layer.inPoint = currentTime;
  layer.outPoint = Math.min(comp.duration, currentTime + layerDuration);
}

function afm_collectSelectedComp(targetFolderPath) {
  var targetFolder = new Folder(targetFolderPath);
  if (!targetFolder.exists) {
    return "ERROR: 当前目录不存在";
  }

  if (!app.project) {
    return "ERROR: 没有打开的 AE 项目";
  }

  var comp = afm_getSelectedComp();
  if (!comp) {
    return "ERROR: 请先在 AE 项目面板中选中一个合成";
  }

  var safeName = afm_safeFileName(comp.name);
  var outFolder = afm_uniqueFolder(targetFolder, safeName);
  if (!outFolder.exists) {
    outFolder.create();
  }

  var footageFolder = new Folder(outFolder.fsName + "/Footage");
  if (!footageFolder.exists) {
    footageFolder.create();
  }

  var outFile = afm_uniqueFile(outFolder, safeName, ".aep");
  var copied = 0;
  var relinked = 0;
  var failed = 0;

  app.beginUndoGroup("AE File Manager Collect Comp");
  try {
    app.project.reduceProject([comp]);
    var collectResult = afm_relinkCollectedFootage(footageFolder);
    copied = collectResult.copied;
    relinked = collectResult.relinked;
    failed = collectResult.failed;
    app.project.save(outFile);
  } catch (err) {
    app.endUndoGroup();
    return "ERROR: 整理合成失败：" + err.toString();
  }
  app.endUndoGroup();

  return "OK: 已整理合成到 " + outFolder.fsName + "，复制素材 " + copied + " 个，重链 " + relinked + " 个，失败 " + failed + " 个";
}

// Project collection is intentionally split across several evalScript calls.
// File copying stays in the CEP/Node side, while AE only handles one relink
// (or one PSD rebuild) at a time, so a large project cannot monopolize AE's UI.
if (typeof afm_collectProjectJobs === "undefined") {
  afm_collectProjectJobs = {};
}
if (typeof afm_collectProjectJobCounter === "undefined") {
  afm_collectProjectJobCounter = 0;
}

function afm_getCollectedTypeFolder(footageFolder, extension, organizeByType) {
  var folderName = "Footage";
  var ext = String(extension || "").toLowerCase();

  if (!organizeByType) {
    return footageFolder;
  }

  if (ext === ".psd") {
    folderName = "PSD";
  } else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".bmp" || ext === ".tif" || ext === ".tiff" || ext === ".webp" || ext === ".exr" || ext === ".dpx") {
    folderName = "Images";
  } else if (ext === ".mp4" || ext === ".mov" || ext === ".avi" || ext === ".mkv" || ext === ".webm" || ext === ".m4v") {
    folderName = "Videos";
  } else if (ext === ".mp3" || ext === ".wav" || ext === ".aif" || ext === ".aiff" || ext === ".m4a" || ext === ".aac") {
    folderName = "Audio";
  } else if (ext === ".ai" || ext === ".eps" || ext === ".svg") {
    folderName = "Design";
  } else if (ext === ".aep" || ext === ".aepx" || ext === ".aet") {
    folderName = "Projects";
  } else {
    folderName = "Other";
  }

  var target = new Folder(footageFolder.fsName + "/" + folderName);
  if (!target.exists) {
    target.create();
  }
  return target;
}

function afm_findProjectPanelFolder(parentFolder, name) {
  if (!parentFolder || !name) return null;
  for (var i = 1; i <= parentFolder.numItems; i += 1) {
    var item = parentFolder.item(i);
    if (item instanceof FolderItem && item.name === name) {
      return item;
    }
  }
  return null;
}

function afm_getProjectPanelFolder(parentFolder, name) {
  var folder = afm_findProjectPanelFolder(parentFolder, name);
  if (folder) return folder;
  return parentFolder.items.addFolder(name);
}

function afm_projectPanelAssetCategory(item) {
  var ext = "";
  var sourceFile;

  if (item instanceof CompItem) return "合成";
  if (!(item instanceof FootageItem)) return "其他素材";

  try {
    sourceFile = item.mainSource && item.mainSource.file;
    if (sourceFile) ext = afm_fileExt(sourceFile.name).toLowerCase();
  } catch (fileErr) {
    ext = "";
  }

  if (ext === ".psd") return "PSD";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".bmp" || ext === ".tif" || ext === ".tiff" || ext === ".webp" || ext === ".exr" || ext === ".dpx") return "图片";
  if (ext === ".mp4" || ext === ".mov" || ext === ".avi" || ext === ".mkv" || ext === ".webm" || ext === ".m4v") return "视频";
  if (ext === ".mp3" || ext === ".wav" || ext === ".aif" || ext === ".aiff" || ext === ".m4a" || ext === ".aac") return "音频";
  if (ext === ".ai" || ext === ".eps" || ext === ".svg") return "设计文件";
  return "其他素材";
}

// Only reorganizes Project panel items. It never copies, relinks, renders, or saves the AEP.
function afm_organizeProjectPanelAssets() {
  var rootFolder;
  var folders = {};
  var items = [];
  var counts = {};
  var categories = ["合成", "图片", "视频", "音频", "PSD", "设计文件", "其他素材"];
  var moved = 0;
  var undoOpen = false;

  try {
    if (!app.project) throw new Error("没有打开的 AE 项目");
    rootFolder = afm_findProjectPanelFolder(app.project.rootFolder, "AE文件管理器_素材整理");
    app.beginUndoGroup("AE File Manager Organize Project Panel");
    undoOpen = true;
    if (!rootFolder) rootFolder = app.project.rootFolder.items.addFolder("AE文件管理器_素材整理");

    for (var categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      folders[categories[categoryIndex]] = afm_getProjectPanelFolder(rootFolder, categories[categoryIndex]);
      counts[categories[categoryIndex]] = 0;
    }

    // Snapshot first because assigning parentFolder changes the project-panel collection.
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {
      var projectItem = app.project.item(itemIndex);
      if (projectItem instanceof CompItem || projectItem instanceof FootageItem) {
        items.push(projectItem);
      }
    }

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var category = afm_projectPanelAssetCategory(item);
      var destination = folders[category] || folders["其他素材"];
      if (item.parentFolder !== destination) {
        item.parentFolder = destination;
        moved += 1;
      }
      counts[category] = (counts[category] || 0) + 1;
    }

    app.endUndoGroup();
    undoOpen = false;
    var summary = [];
    for (var summaryIndex = 0; summaryIndex < categories.length; summaryIndex += 1) {
      var categoryName = categories[summaryIndex];
      if (counts[categoryName]) summary.push(categoryName + " " + counts[categoryName]);
    }
    return "OK: 已整理项目面板 " + items.length + " 项，实际移动 " + moved + " 项；" + (summary.length ? summary.join("、") : "没有可整理的素材或合成") + "。未复制文件、未重链、未保存工程";
  } catch (err) {
    if (undoOpen) {
      try { app.endUndoGroup(); } catch (ignoreEnd) {}
    }
    return "ERROR: 整理项目面板失败：" + err.toString();
  }
}

function afm_prepareCollectProject(targetFolderPath, organizeByType) {
  var targetFolder = new Folder(targetFolderPath);
  var projectName;
  var outFolder;
  var footageFolder;
  var outFile;
  var originalItemCount;
  var originalComps = [];
  var entries = [];
  var seen = {};
  var reserved = {};
  var jobId;

  organizeByType = organizeByType === true || organizeByType === "true";

  if (!targetFolder.exists) {
    return "ERROR: 当前目录不存在";
  }
  if (!app.project) {
    return "ERROR: 没有打开的 AE 项目";
  }

  projectName = app.project.file ? afm_fileBaseName(afm_decodeName(app.project.file.name)) : "未命名工程";
  outFolder = afm_uniqueFolder(targetFolder, afm_safeFileName(projectName) + "_工程整理");
  if (!outFolder.exists && !outFolder.create()) {
    return "ERROR: 无法创建整理目录";
  }

  footageFolder = new Folder(outFolder.fsName + "/Footage");
  if (!footageFolder.exists && !footageFolder.create()) {
    return "ERROR: 无法创建 Footage 目录";
  }
  outFile = afm_uniqueFile(outFolder, afm_safeFileName(projectName) + "_整理", ".aep");

  originalItemCount = app.project.numItems;
  for (var i = 1; i <= originalItemCount; i += 1) {
    var originalItem = app.project.item(i);
    if (originalItem instanceof CompItem) {
      originalComps.push(originalItem);
    }
    if (!(originalItem instanceof FootageItem) || !originalItem.mainSource || !originalItem.mainSource.file) {
      continue;
    }

    var sourceFile = originalItem.mainSource.file;
    var sourcePath = sourceFile.fsName;
    var existing = seen[sourcePath];
    if (existing) {
      existing.items.push(originalItem);
      continue;
    }

    var sourceName = afm_decodeName(sourceFile.name);
    var baseName = afm_safeFileName(afm_fileBaseName(sourceName));
    var ext = afm_fileExt(sourceName);
    var targetFile = afm_uniqueReservedFile(afm_getCollectedTypeFolder(footageFolder, ext, organizeByType), baseName, ext, reserved);
    var entry = {
      sourcePath: sourcePath,
      targetPath: targetFile.fsName,
      isPsd: ext.toLowerCase() === ".psd",
      items: [originalItem]
    };
    seen[sourcePath] = entry;
    entries.push(entry);
  }

  if (!entries.length) {
    return "ERROR: 工程中没有可整理的本地素材";
  }

  afm_collectProjectJobCounter += 1;
  jobId = afm_timestamp() + "_" + afm_collectProjectJobCounter;
  afm_collectProjectJobs[jobId] = {
    outFolder: outFolder.fsName,
    footageFolder: footageFolder.fsName,
    organizeByType: organizeByType,
    outFile: outFile.fsName,
    entries: entries,
    originalComps: originalComps,
    remappedPsdItems: [],
    relinked: 0,
    failed: 0,
    completed: false
  };

  var files = [];
  for (var j = 0; j < entries.length; j += 1) {
    files.push({
      sourcePath: entries[j].sourcePath,
      targetPath: entries[j].targetPath,
      isPsd: entries[j].isPsd
    });
  }

  return JSON.stringify({
    ok: true,
    jobId: jobId,
    outputFolder: outFolder.fsName,
    organizeByType: organizeByType,
    total: files.length,
    files: files
  });
}

function afm_collectProjectRelinkStep(jobId, index, copySucceeded) {
  var job = afm_collectProjectJobs[jobId];
  var entry;
  var sourceFile;
  var copiedFile;
  var stepRelinked = 0;
  var stepFailed = 0;
  var stepError = "";

  if (!job || job.completed) {
    return "ERROR: 整理任务不存在或已完成";
  }
  index = parseInt(index, 10);
  if (isNaN(index) || index < 0 || index >= job.entries.length) {
    return "ERROR: 整理任务索引无效";
  }

  entry = job.entries[index];
  if (!copySucceeded) {
    job.failed += entry.items.length;
    return JSON.stringify({ ok: true, index: index, relinked: 0, failed: entry.items.length });
  }

  sourceFile = new File(entry.sourcePath);
  copiedFile = new File(entry.targetPath);
  if (!sourceFile.exists || !copiedFile.exists) {
    job.failed += entry.items.length;
    return JSON.stringify({ ok: true, index: index, relinked: 0, failed: entry.items.length });
  }

  app.beginUndoGroup("AE File Manager Relink " + (index + 1));
  try {
    if (entry.isPsd) {
      afm_relinkPsdSource(sourceFile, copiedFile, job.originalComps, job.remappedPsdItems);
    }

    for (var i = 0; i < entry.items.length; i += 1) {
      var item = entry.items[i];
      if (afm_containsObject(job.remappedPsdItems, item)) {
        stepRelinked += 1;
        continue;
      }
      try {
        item.replace(copiedFile);
        stepRelinked += 1;
      } catch (replaceErr) {
        stepFailed += 1;
      }
    }
  } catch (err) {
    stepError = err.toString();
  }
  app.endUndoGroup();

  if (stepError) {
    stepFailed += entry.items.length - stepRelinked - stepFailed;
  }
  job.relinked += stepRelinked;
  job.failed += stepFailed;

  return JSON.stringify({
    ok: true,
    index: index,
    relinked: stepRelinked,
    failed: stepFailed,
    error: stepError
  });
}

function afm_finishCollectProject(jobId) {
  var job = afm_collectProjectJobs[jobId];
  var outputFile;

  if (!job || job.completed) {
    return "ERROR: 整理任务不存在或已完成";
  }

  outputFile = new File(job.outFile);
  try {
    app.project.save(outputFile);
  } catch (err) {
    return "ERROR: 整理工程保存失败：" + err.toString();
  }

  job.completed = true;
  var result = "OK: 已整理工程到 " + job.outFolder + "，复制素材 " + job.entries.length + " 个，重链 " + job.relinked + " 个，失败 " + job.failed + " 个";
  delete afm_collectProjectJobs[jobId];
  return result;
}

function afm_cancelCollectProject(jobId) {
  if (afm_collectProjectJobs[jobId]) {
    delete afm_collectProjectJobs[jobId];
  }
  return "OK";
}

// Keep the old entry point non-blocking for stale panels or external callers.
function afm_collectProject(targetFolderPath) {
  return "ERROR: 整理工程已改为分阶段执行，请关闭并重新打开插件面板";
}

function afm_uniqueReservedFile(folder, baseName, ext, reserved) {
  var index = 0;
  var file;
  var suffix;

  while (true) {
    suffix = index === 0 ? "" : "_" + index;
    file = new File(folder.fsName + "/" + baseName + suffix + ext);
    if (!file.exists && !reserved[file.fsName]) {
      reserved[file.fsName] = true;
      return file;
    }
    index += 1;
  }
}

// Relink the original project items without changing their import structure.
// PSD compositions need to be rebuilt from the copied file because FootageItem
// .replace() flattens a PSD layer import back to a single footage item.
function afm_relinkCollectedFootage(footageFolder) {
  var originalItemCount = app.project.numItems;
  var originalFootageItems = [];
  var originalComps = [];
  var seen = {};
  var handledPsd = {};
  var remappedPsdItems = [];
  var copied = 0;
  var relinked = 0;
  var failed = 0;

  for (var i = 1; i <= originalItemCount; i += 1) {
    var originalItem = app.project.item(i);
    if (originalItem instanceof CompItem) {
      originalComps.push(originalItem);
    }
    if (originalItem instanceof FootageItem && originalItem.mainSource && originalItem.mainSource.file) {
      originalFootageItems.push(originalItem);
    }
  }

  for (var j = 0; j < originalFootageItems.length; j += 1) {
    var item = originalFootageItems[j];

    var sourceFile = item.mainSource.file;
    if (!sourceFile.exists) {
      failed += 1;
      continue;
    }

    var sourceKey = sourceFile.fsName;
    var copiedFile;
    if (seen[sourceKey]) {
      copiedFile = new File(seen[sourceKey]);
    } else {
      copiedFile = afm_copyFootageFile(sourceFile, footageFolder);
      if (!copiedFile) {
        failed += 1;
        continue;
      }
      seen[sourceKey] = copiedFile.fsName;
      copied += 1;
    }

    var isPsd = afm_fileExt(sourceFile.name).toLowerCase() === ".psd";
    if (isPsd && !handledPsd[sourceKey]) {
      handledPsd[sourceKey] = true;
      afm_relinkPsdSource(sourceFile, copiedFile, originalComps, remappedPsdItems);
    }

    // This item has already been replaced with the matching layer source from
    // the rebuilt PSD composition. Replacing it again would flatten it.
    if (afm_containsObject(remappedPsdItems, item)) {
      relinked += 1;
      continue;
    }

    try {
      item.replace(copiedFile);
      relinked += 1;
    } catch (replaceErr) {
      failed += 1;
    }
  }

  return { copied: copied, relinked: relinked, failed: failed };
}

function afm_relinkPsdSource(sourceFile, copiedFile, originalComps, remappedItems) {
  var sourceComps = afm_findPsdSourceComps(sourceFile, originalComps);
  if (!sourceComps.length) {
    return false;
  }

  for (var i = 0; i < sourceComps.length; i += 1) {
    var originalComp = sourceComps[i];
    var rebuiltComp = afm_importMatchingPsdComp(copiedFile, originalComp);
    if (!rebuiltComp) {
      continue;
    }

    afm_replacePsdCompSources(originalComp, rebuiltComp, remappedItems);

    // The temporary composition is only used to obtain correctly separated
    // PSD layer sources. Keep those sources through the old comp references.
    try {
      rebuiltComp.remove();
    } catch (removeErr) {
    }
  }

  return true;
}

function afm_findPsdSourceComps(sourceFile, originalComps) {
  var result = [];
  var sourceKey = sourceFile.fsName;

  for (var i = 0; i < originalComps.length; i += 1) {
    var item = originalComps[i];

    for (var j = 1; j <= item.numLayers; j += 1) {
      var layer = item.layer(j);
      var source = layer && layer.source;
      if (source instanceof FootageItem && source.mainSource && source.mainSource.file &&
          source.mainSource.file.fsName === sourceKey) {
        result.push(item);
        break;
      }
    }
  }

  return result;
}

function afm_importMatchingPsdComp(copiedFile, originalComp) {
  var candidates = [];
  var modes = [];

  if (typeof ImportAsType !== "undefined") {
    modes.push(ImportAsType.COMP_CROPPED_LAYERS);
    modes.push(ImportAsType.COMP);
  }

  for (var i = 0; i < modes.length; i += 1) {
    try {
      var options = new ImportOptions(copiedFile);
      if (options.canImportAs && !options.canImportAs(modes[i])) {
        continue;
      }
      options.importAs = modes[i];
      var candidate = app.project.importFile(options);
      if (candidate instanceof CompItem) {
        candidates.push(candidate);
      }
    } catch (importErr) {
    }
  }

  if (!candidates.length) {
    return null;
  }

  var best = candidates[0];
  var bestScore = afm_scorePsdComp(originalComp, best);
  for (var j = 1; j < candidates.length; j += 1) {
    var score = afm_scorePsdComp(originalComp, candidates[j]);
    if (score < bestScore) {
      best = candidates[j];
      bestScore = score;
    }
  }

  for (var k = 0; k < candidates.length; k += 1) {
    if (candidates[k] !== best) {
      try {
        candidates[k].remove();
      } catch (removeErr2) {
      }
    }
  }

  return best;
}

function afm_scorePsdComp(originalComp, candidateComp) {
  var score = Math.abs(originalComp.width - candidateComp.width) +
    Math.abs(originalComp.height - candidateComp.height);
  score += Math.abs(originalComp.numLayers - candidateComp.numLayers) * 100000;

  var count = Math.min(originalComp.numLayers, candidateComp.numLayers);
  for (var i = 1; i <= count; i += 1) {
    var oldSource = originalComp.layer(i).source;
    var newSource = candidateComp.layer(i).source;
    if (oldSource && newSource && oldSource.width !== undefined && newSource.width !== undefined) {
      score += Math.abs(oldSource.width - newSource.width);
      score += Math.abs(oldSource.height - newSource.height);
    }
  }

  return score;
}

function afm_replacePsdCompSources(originalComp, rebuiltComp, remappedItems) {
  var count = Math.min(originalComp.numLayers, rebuiltComp.numLayers);
  for (var i = 1; i <= count; i += 1) {
    var oldLayer = originalComp.layer(i);
    var newLayer = rebuiltComp.layer(i);
    var oldSource = oldLayer && oldLayer.source;
    var newSource = newLayer && newLayer.source;

    if (!oldSource || !newSource || typeof oldLayer.replaceSource !== "function") {
      continue;
    }

    try {
      oldLayer.replaceSource(newSource, false);
      afm_pushUniqueObject(remappedItems, oldSource);
    } catch (replaceErr) {
    }
  }
}

function afm_containsObject(items, target) {
  for (var i = 0; i < items.length; i += 1) {
    if (items[i] === target) {
      return true;
    }
  }
  return false;
}

function afm_pushUniqueObject(items, value) {
  if (!afm_containsObject(items, value)) {
    items.push(value);
  }
}

function afm_replaceSelectedLayers(jsonPayload) {
  var payload;
  var paths;
  var sequence;
  var comp;
  var layers;
  var replaced = 0;
  var failed = [];
  var importedItems = [];

  try {
    payload = afm_parsePayload(jsonPayload);
  } catch (err) {
    return "ERROR: 无法解析替换参数";
  }

  paths = payload.paths || [];
  sequence = !!payload.sequence;
  if (!paths.length) {
    return "ERROR: 没有可替换的素材";
  }

  comp = afm_getTargetComp();
  if (!(comp instanceof CompItem)) {
    return "ERROR: 请先打开一个合成，并选中要替换的图层";
  }

  layers = comp.selectedLayers;
  if (!layers || !layers.length) {
    return "ERROR: 请先在当前合成中选中要替换的图层";
  }

  app.beginUndoGroup("AE File Manager Replace Layers");
  for (var i = 0; i < layers.length; i += 1) {
    var filePath = paths.length === 1 ? paths[0] : paths[Math.min(i, paths.length - 1)];
    var layer = layers[i];
    var file = new File(filePath);

    if (!file.exists || !layer || typeof layer.replaceSource !== "function") {
      failed.push(layer && layer.name ? layer.name : filePath);
      continue;
    }

    try {
      var options = new ImportOptions(file);
      if (sequence && options.sequence !== undefined) {
        options.sequence = true;
      }
      var importedItem = app.project.importFile(options);
      if (importedItem) {
        importedItems.push(importedItem);
      }
      layer.replaceSource(importedItem, false);
      replaced += 1;
    } catch (err2) {
      failed.push(layer.name);
    }
  }
  app.endUndoGroup();
  afm_selectProjectItems(importedItems);

  if (failed.length) {
    return "OK: 已替换 " + replaced + " 个图层，失败 " + failed.length + " 个";
  }
  return "OK: 已替换 " + replaced + " 个图层";
}

function afm_findCompByName(name) {
  if (!app.project) return null;
  for (var i = 1; i <= app.project.numItems; i += 1) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === name) return item;
  }
  return null;
}

function afm_uniqueCompCopyName(name) {
  var base = String(name || "合成") + "_副本";
  var candidate = base;
  var index = 2;
  while (afm_findCompByName(candidate)) {
    candidate = base + "_" + index;
    index += 1;
  }
  return candidate;
}

function afm_duplicateCompTree(sourceComp, mappings) {
  var existing;
  var duplicate;
  var mapping;

  for (var i = 0; i < mappings.length; i += 1) {
    if (mappings[i].source === sourceComp) return mappings[i].duplicate;
  }

  duplicate = sourceComp.duplicate();
  mapping = { source: sourceComp, duplicate: duplicate };
  mappings.push(mapping);

  for (var layerIndex = 1; layerIndex <= duplicate.numLayers; layerIndex += 1) {
    var layer = duplicate.layer(layerIndex);
    var nestedSource = layer && layer.source;
    if (nestedSource instanceof CompItem && typeof layer.replaceSource === "function") {
      var nestedDuplicate = afm_duplicateCompTree(nestedSource, mappings);
      try { layer.replaceSource(nestedDuplicate, false); } catch (replaceErr) {}
    }
  }
  return duplicate;
}

function afm_duplicateTargetComp() {
  var comp;
  var duplicate;
  var undoOpen = false;

  try {
    if (!app.project) throw new Error("没有打开的 AE 项目");
    comp = afm_getTargetComp();
    if (!(comp instanceof CompItem)) throw new Error("请先打开或选中一个合成");
    app.beginUndoGroup("AE File Manager Duplicate Comp");
    undoOpen = true;
    duplicate = afm_duplicateCompTree(comp, []);
    duplicate.name = afm_uniqueCompCopyName(comp.name);
    duplicate.selected = true;
    app.endUndoGroup();
    undoOpen = false;
    return "OK: 已复制合成“" + duplicate.name + "”，内部预合成已独立复制";
  } catch (err) {
    if (undoOpen) {
      try { app.endUndoGroup(); } catch (ignoreEnd) {}
    }
    return "ERROR: 复制合成失败：" + err.toString();
  }
}

function afm_findOutputTemplate(outputModule) {
  var candidates = ["AfterCodecs_mp4", "AfterCodecs .mp4", "AfterCodecs.mp4", "AfterCodecs MP4", "AfterCodecs", "H.264", "H264"];
  for (var i = 0; i < candidates.length; i += 1) {
    try {
      outputModule.applyTemplate(candidates[i]);
      return candidates[i];
    } catch (err) {}
  }
  return "";
}

function afm_exportCompConfigured(targetFolderPath) {
  var targetFolder = new Folder(targetFolderPath);
  var comp;
  var outputFile;
  var queueItem;
  var outputModule;
  var templateName;
  var previousStates = [];
  var renderStarted = false;

  try {
    if (!targetFolder.exists) throw new Error("当前目录不存在");
    if (!app.project) throw new Error("没有打开的 AE 项目");
    comp = afm_getTargetComp();
    if (!(comp instanceof CompItem)) throw new Error("请先打开或选中一个合成");

    outputFile = afm_uniqueFile(targetFolder, afm_safeFileName(comp.name), ".mp4");
    queueItem = app.project.renderQueue.items.add(comp);
    outputModule = queueItem.outputModule(1);
    templateName = afm_findOutputTemplate(outputModule);
    if (!templateName) {
      queueItem.remove();
      throw new Error("未找到 AfterCodecs 或 H.264 输出模板，请先安装 AfterCodecs 或在 AE 中创建同名模板");
    }

    outputModule.file = outputFile;
    queueItem.timeSpanStart = 0;
    queueItem.timeSpanDuration = comp.duration;
    for (var i = 1; i <= app.project.renderQueue.numItems; i += 1) {
      var item = app.project.renderQueue.item(i);
      previousStates.push({ item: item, render: item.render });
      item.render = item === queueItem;
    }

    app.project.renderQueue.render();
    renderStarted = true;
    for (var j = 0; j < previousStates.length; j += 1) {
      previousStates[j].item.render = previousStates[j].render;
    }
    queueItem.render = false;
    return JSON.stringify({ ok: true, template: templateName, path: outputFile.fsName, message: "已使用 “" + templateName + "” 导出到 " + outputFile.fsName });
  } catch (err) {
    for (var k = 0; k < previousStates.length; k += 1) {
      try { previousStates[k].item.render = previousStates[k].render; } catch (restoreErr) {}
    }
    if (!renderStarted && queueItem) {
      try { queueItem.remove(); } catch (removeErr) {}
    }
    return JSON.stringify({ ok: false, error: err.toString() });
  }
}

function afm_captureCurrentFrame(targetFolderPath) {
  var targetFolder = new Folder(targetFolderPath);
  if (!targetFolder.exists) {
    return "ERROR: 当前目录不存在";
  }

  if (!app.project) {
    return "ERROR: 没有打开的 AE 项目";
  }

  // The CEP panel takes focus away from the comp viewer, so activeItem can be
  // null even while the user has a comp open. Use the same target resolution
  // as import, replace, duplicate, and expression actions.
  var comp = afm_getTargetComp();
  if (!(comp instanceof CompItem)) {
    return "ERROR: 请先打开一个合成，再截图当前画面";
  }

  var baseName = afm_safeFileName(comp.name) + "_截图_" + afm_timestamp();
  var outFile = afm_uniqueFile(targetFolder, baseName, ".png");

  try {
    comp.saveFrameToPng(comp.time, outFile);
  } catch (err) {
    return "ERROR: 截图失败：" + err.toString();
  }

  return "OK:" + outFile.fsName;
}

// Render selected visual layers in temporary comp duplicates. Never change
// solo/enabled/guide/matte states in the user's original composition.
function afm_exportSelectedLayersForAi(targetFolderPath, availableSlots) {
  var temporary = null;
  var undoOpen = false;
  var savedSelection = [];
  var paths = [];
  var warnings = [];
  var fatal = "";
  try {
    if (!app.project) throw new Error("没有打开的 AE 项目");
    var comp = afm_getTargetComp();
    if (!(comp instanceof CompItem)) throw new Error("请打开合成，并在时间轴选中需要导入的图层");
    var layers = comp.selectedLayers;
    if (!layers || !layers.length) throw new Error("请先在 AE 时间轴中选中图层；项目素材请使用 AE 选中素材按钮");
    var folder = new Folder(targetFolderPath);
    if (!folder.exists) throw new Error("参考图目录不存在");
    var limit = Math.max(0, Math.min(8, Number(availableSlots) || 0));
    var indexes = [];
    var time = comp.time;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!(layer instanceof AVLayer) || layer.nullLayer || layer.adjustmentLayer) { warnings.push("跳过非画面图层：" + layer.name); continue; }
      if (time < layer.inPoint || time >= layer.outPoint) { warnings.push("当前指针不在图层范围：" + layer.name); continue; }
      indexes.push(layer.index);
    }
    if (!indexes.length) throw new Error(warnings.join("；") || "没有可导出的画面图层");
    if (indexes.length > limit) throw new Error("参考图剩余 " + limit + " 个位置，请减少选中图层或先移除参考图");
    var selection = app.project.selection || [];
    for (i = 0; i < selection.length; i++) savedSelection.push(selection[i]);
    app.beginUndoGroup("导入 AI 参考图层");
    undoOpen = true;
    for (i = 0; i < indexes.length; i++) {
      try {
        temporary = comp.duplicate();
        temporary.name = "__AFM_AI_REFERENCE_" + new Date().getTime();
        for (var j = 1; j <= temporary.numLayers; j++) {
          var other = temporary.layer(j);
          other.locked = false;
          other.solo = other instanceof CameraLayer || other instanceof LightLayer;
        }
        var target = temporary.layer(indexes[i]);
        target.solo = true;
        target.enabled = true;
        target.guideLayer = false;
        var matte = null;
        try {
          if (target.hasTrackMatte) matte = target.trackMatteLayer || (target.index > 1 ? temporary.layer(target.index - 1) : null);
        } catch (ignoreMatte) {}
        if (matte) matte.solo = true;
        var outFile = afm_uniqueFile(folder, afm_safeFileName(comp.name + "_" + target.name) + "_图层_" + afm_timestamp(), ".png");
        temporary.saveFrameToPng(time, outFile);
        if (!outFile.exists) throw new Error("AE 没有写入图片文件");
        paths.push(outFile.fsName);
      } catch (layerError) { warnings.push("图层 " + indexes[i] + " 导出失败：" + layerError.toString()); }
      finally {
        if (temporary) {
          try { temporary.remove(); } catch (cleanupError) { warnings.push("临时合成清理失败，请检查 __AFM_AI_REFERENCE_ 合成"); }
          temporary = null;
        }
      }
    }
  } catch (err) { fatal = err.toString(); }
  finally {
    if (undoOpen) {
      try { afm_selectProjectItems(savedSelection); } catch (ignoreSelection) {}
      app.endUndoGroup();
    }
  }
  if (fatal || !paths.length) return JSON.stringify({ ok: false, error: fatal || warnings.join("；") || "没有导出图片" });
  return JSON.stringify({ ok: true, paths: paths, warnings: warnings });
}

function afm_chooseExpressionExportPath() {
  try {
    var file = File.saveDialog("导出表达式库", "JSON:*.json");
    if (!file) return JSON.stringify({ ok: false, cancelled: true });
    var path = file.fsName;
    if (!/\.json$/i.test(path)) path += ".json";
    return JSON.stringify({ ok: true, path: path });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.toString() });
  }
}

function afm_applyExpressionItem(jsonPayload) {
  var script;
  var comp;
  var applied = 0;
  var undoOpen = false;
  try {
    script = afm_parsePayload(jsonPayload);
    if (!script || typeof script !== "object") throw new Error("表达式参数无效");
    script.code = String(script.code || script.expressionCode || "");
    if (!app.project) throw new Error("请先打开 AE 工程");
    comp = afm_getTargetComp();
    if (!(comp instanceof CompItem)) throw new Error("请先打开或选中一个合成");
    if (script.type === "action") {
      if (script.id !== "move_5_frames") throw new Error("不支持的动作表达式");
      app.beginUndoGroup(script.name || "移动时间指针");
      undoOpen = true;
      comp.time += 5 * comp.frameDuration;
      app.endUndoGroup();
      undoOpen = false;
      return JSON.stringify({ ok: true, applied: 1, message: "时间指针已前进 5 帧" });
    }
    if (!script.code.replace(/^\s+|\s+$/g, "")) throw new Error("表达式代码不能为空");
    if (!comp.selectedLayers || comp.selectedLayers.length < 1) throw new Error("请先选择至少一个图层");
    var propertyName = String(script.type || "").split(".")[1];
    var propertyMap = {
      opacity: ["ADBE Opacity", "Opacity", "不透明度", "opacity"],
      scale: ["ADBE Scale", "Scale", "缩放", "scale"],
      rotation: ["ADBE Rotate Z", "Rotation", "旋转", "rotation"],
      position: ["ADBE Position", "Position", "位置", "position"],
      anchorPoint: ["ADBE Anchor Point", "Anchor Point", "锚点", "anchorPoint"]
    };
    var names = propertyMap[propertyName];
    if (!names) throw new Error("不支持的表达式属性");
    app.beginUndoGroup(script.name || "应用表达式");
    undoOpen = true;
    for (var i = 0; i < comp.selectedLayers.length; i += 1) {
      var transform = comp.selectedLayers[i].property("ADBE Transform Group") || comp.selectedLayers[i].property("Transform") || comp.selectedLayers[i].property("变换");
      var prop = null;
      if (transform) {
        for (var j = 0; j < names.length; j += 1) {
          prop = transform.property(names[j]);
          if (prop) break;
        }
      }
      if (prop && prop.canSetExpression) {
        prop.expression = script.code;
        applied += 1;
      }
    }
    app.endUndoGroup();
    undoOpen = false;
    if (!applied) throw new Error("所选图层中没有可写入该表达式的属性");
    return JSON.stringify({ ok: true, applied: applied, message: "已应用到 " + applied + " 个图层" });
  } catch (err) {
    if (undoOpen) {
      try { app.endUndoGroup(); } catch (ignoreEnd) {}
    }
    return JSON.stringify({ ok: false, error: err.toString(), applied: applied });
  }
}

function afm_fitLayerToComp(layer, comp, fitAxis) {
  if (!layer || !layer.source || !layer.source.width || !layer.source.height) return;
  var scaleValue = fitAxis === "width"
    ? (comp.width / layer.source.width) * 100
    : (comp.height / layer.source.height) * 100;
  var transform = layer.property("ADBE Transform Group");
  if (!transform) return;
  var position = transform.property("ADBE Position");
  var scale = transform.property("ADBE Scale");
  if (position) position.setValue([comp.width / 2, comp.height / 2]);
  if (scale) {
    if (scale.value.length === 3) scale.setValue([scaleValue, scaleValue, scaleValue]);
    else scale.setValue([scaleValue, scaleValue]);
  }
}

function afm_getSelectedComp() {
  var selection = app.project.selection || [];
  for (var i = 0; i < selection.length; i += 1) {
    if (selection[i] instanceof CompItem) {
      return selection[i];
    }
  }
  if (app.project.activeItem && app.project.activeItem instanceof CompItem) {
    return app.project.activeItem;
  }
  return null;
}

function afm_getTargetComp() {
  if (app.project.activeItem && app.project.activeItem instanceof CompItem) {
    return app.project.activeItem;
  }
  return afm_getSelectedComp();
}

function afm_clearProjectSelection() {
  if (!app.project || !app.project.selection) {
    return;
  }
  var selection = app.project.selection;
  for (var i = selection.length - 1; i >= 0; i -= 1) {
    try {
      selection[i].selected = false;
    } catch (err) {
    }
  }
}

function afm_selectProjectItems(items) {
  if (!items || !items.length) {
    return;
  }
  afm_clearProjectSelection();
  for (var i = 0; i < items.length; i += 1) {
    try {
      items[i].selected = true;
    } catch (err) {
    }
  }
}

function afm_getSelectedFootagePath() {
  if (!app.project) {
    return "ERROR: 没有打开的 AE 项目";
  }

  var selection = app.project.selection;
  for (var i = 0; i < selection.length; i += 1) {
    var item = selection[i];
    if (item instanceof FootageItem && item.mainSource && item.mainSource.file) {
      return item.mainSource.file.fsName;
    }
  }

  if (app.project.activeItem instanceof FootageItem && app.project.activeItem.mainSource && app.project.activeItem.mainSource.file) {
    return app.project.activeItem.mainSource.file.fsName;
  }

  return "ERROR: 请先在 AE 项目面板中选中一个本地素材";
}

function afm_safeFileName(name) {
  return String(name).replace(/[\\\/:*?"<>|]/g, "_");
}

function afm_decodeName(name) {
  try {
    return File.decode(name);
  } catch (err) {
    return String(name);
  }
}

function afm_fileBaseName(name) {
  var value = String(name || "未命名工程");
  var dot = value.lastIndexOf(".");
  return dot > 0 ? value.substring(0, dot) : value;
}

function afm_fileExt(name) {
  var value = String(name || "");
  var dot = value.lastIndexOf(".");
  return dot > -1 ? value.substring(dot) : "";
}

function afm_copyFootageFile(sourceFile, footageFolder) {
  var sourceName = afm_decodeName(sourceFile.name);
  var baseName = afm_safeFileName(afm_fileBaseName(sourceName));
  var ext = afm_fileExt(sourceName);
  var target = afm_uniqueFile(footageFolder, baseName, ext);
  try {
    if (sourceFile.copy(target.fsName)) {
      return target;
    }
  } catch (err) {
    return null;
  }
  return target.exists ? target : null;
}

function afm_uniqueFolder(parentFolder, baseName) {
  var folder = new Folder(parentFolder.fsName + "/" + baseName);
  var index = 1;
  while (folder.exists) {
    folder = new Folder(parentFolder.fsName + "/" + baseName + "_" + index);
    index += 1;
  }
  return folder;
}

function afm_timestamp() {
  var now = new Date();
  return [
    now.getFullYear(),
    afm_pad(now.getMonth() + 1),
    afm_pad(now.getDate()),
    "_",
    afm_pad(now.getHours()),
    afm_pad(now.getMinutes()),
    afm_pad(now.getSeconds())
  ].join("");
}

function afm_pad(value) {
  return value < 10 ? "0" + value : String(value);
}

function afm_uniqueFile(folder, baseName, ext) {
  var file = new File(folder.fsName + "/" + baseName + ext);
  var index = 1;
  while (file.exists) {
    file = new File(folder.fsName + "/" + baseName + "_" + index + ext);
    index += 1;
  }
  return file;
}

function afm_ping() {
  return app.name + " " + app.version;
}
