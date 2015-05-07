var _ = require('lodash');
var async = require('async');
var fs = require('fs-extra');
var path = require('path');
var S = require('string');
var log = require('verr-log')();

var util = require('any2api-util');



var downloadDeps = function(metadata, dir, done) {
  if (_.isEmpty(metadata.dependencies)) return done();

  async.eachSeries(_.keys(metadata.dependencies), function(dep, callback) {
    var depDir = path.join(dir, dep);
    var ver = metadata.dependencies[dep];
    
    if (fs.existsSync(depDir)) return callback();

    var url = 'https://supermarket.chef.io/cookbooks/' + dep + '/download';

    if (S(ver).startsWith('=')) {
      ver = ver.substr(1).trim();

      url = 'https://supermarket.chef.io/cookbooks/' + dep + '/versions/' + ver + '/download';
    }

    //TODO: if ver starts with '<' or '<=', look for corresponding version at https://supermarket.chef.io/api/v1/cookbooks/<NAME>

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



util.readInput(null, function(err, input) {
  if (err) { log.error(err); process.exit(1); }

  if (!input.executable) { log.error('executable (cookbook) missing'); process.exit(1); }

  var executable = input.executable;
  var execPath = path.resolve(input.specPath, '..', executable.path);
  var metadata = JSON.parse(fs.readFileSync(path.join(execPath, 'metadata.json')));
  var depsSubdir = 'cookbook_dependencies';
  var depsPath = path.join(execPath, depsSubdir);

  fs.mkdirsSync(depsPath);

  downloadDeps(metadata, depsPath, function(err) {
    if (err) { log.error(err); process.exit(1); }

    process.exit();

    /*executable.dependencies_subdir = depsSubdir;

    util.writeSpec({ apiSpec: apiSpec }, function(err) {
      if (err) { log.error(err); process.exit(1); }
    });*/
  });
});
