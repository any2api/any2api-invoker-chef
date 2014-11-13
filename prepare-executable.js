var _ = require('lodash');
var async = require('async');
var fs = require('fs-extra');
var path = require('path');

var util = require('any2api-util');



var downloadDeps = function(metadata, dir, done) {
  if (_.isEmpty(metadata.dependencies)) return done();

  async.eachSeries(_.keys(metadata.dependencies), function(dep, callback) {
    var depDir = path.join(dir, dep);
    
    if (fs.existsSync(depDir)) return callback();

    var url = 'https://supermarket.getchef.com/cookbooks/' + dep + '/download';

    util.download({ dir: depDir, url: url }, function(err) {
      if (err) {
        fs.removeSync(depDir);

        return callback(err);
      }

      var metadataFile = path.join(depDir, 'metadata.json');

      if (fs.existsSync(metadataFile)) {
        var metadata = JSON.parse(fs.readFileSync(metadataFile));

        downloadDeps(metadata, dir, callback);
      }
    });
  }, done);
};



util.readInput(null, function(err, apiSpec) {
  var execPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.executable.path);
  var metadata = JSON.parse(fs.readFileSync(path.join(execPath, 'metadata.json')));
  var depsSubdir = 'cookbook_dependencies';
  var depsPath = path.join(execPath, depsSubdir);

  fs.mkdirsSync(depsPath);

  downloadDeps(metadata, depsPath, function(err) {
    if (err) throw err;

    apiSpec.executable.dependencies_subdir = depsSubdir;

    fs.writeFileSync(apiSpec.apispec_path, JSON.stringify(apiSpec, null, 2));
  });
});
