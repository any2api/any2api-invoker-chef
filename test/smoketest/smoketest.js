var chai = require('chai');
var expect = chai.expect;
var fs = require('fs-extra');
var path = require('path');
var async = require('async');
var util = require('any2api-util');

var timeout = 1000 * 60 * 15; // 15 minutes

var invokerPath = path.join(__dirname, '..', '..');
var specPathMysql = path.join(__dirname, 'mysql-apispec.json');

var apiSpecMysql = {
  "executables": {
    "mysql": {
      "parameters_schema": {
        "run_list": {
          "type": "json_array",
          "default": [
            "recipe[mysql::client]"
          ]
        }
      },
      "parameters_required": [
        "run_list"
      ],
      "results_schema": {
        "metadata": {
          "type": "string",
          "mapping": "file",
          "file_path": "./metadata.json"
        }
      },
      "path": "./cookbooks/mysql",
      "invoker_name": "chef"
    }
  },
  "invokers": {
    "chef": {
      "path": invokerPath,
      "expose": true
    }
  },
  apispec_path: specPathMysql
};

var embeddedInstance = {
  "parameters": {
    "run_list": [
      "recipe[embedded]"
    ],
    "invoker_config": {
      "access": "local"
    }
  },
  "executable": {
    "files": [
      {
        "path": "metadata.json",
        "object": {
          "name": "embedded",
          "dependencies": {
            "mysql": "= 5.6.1"
          }
        }
      },
      {
        "path": "recipes/default.rb",
        "text": "include_recipe \"mysql::server\"\n"
      },
      {
        "path": "README.md",
        "url": "https://raw.githubusercontent.com/any2api/any2api-cli/master/README.md"
      }
    ]
  }
};


var cleanup = function(done) {
  async.series([
    async.apply(fs.remove, specPathMysql),
    async.apply(fs.remove, path.join(path.dirname(specPathMysql), apiSpecMysql.executables.mysql.path, 'cookbook_dependencies')),
    async.apply(fs.remove, path.join(invokerPath, 'invoker-status.json')),
    async.apply(fs.remove, path.join(invokerPath, 'node_modules'))
  ], done);
};



describe('mysql cookbook', function() {
  this.timeout(timeout);

  before(cleanup);

  it('prepare buildtime', function(done) {
    util.prepareBuildtime({ apiSpec: apiSpecMysql,
                            executable_name: 'mysql' }, function(err) {
                              if (err) throw err;
                              
                              done();
                            });
  });

  it('prepare executable', function(done) {
    util.prepareExecutable({ apiSpec: apiSpecMysql,
                             executable_name: 'mysql' }, function(err, updatedSpec) {
                               if (err) throw err;

                               apiSpecMysql = updatedSpec;

                               expect(updatedSpec.executables.mysql.prepared).to.be.true;

                               done();
                             });
  });

  it('prepare runtime', function(done) {
    util.prepareRuntime({ apiSpec: apiSpecMysql,
                          executable_name: 'mysql' }, function(err) {
                            if (err) throw err;
                            
                            done();
                          });
  });

  it('invoke executable', function(done) {
    util.invokeExecutable({ apiSpec: apiSpecMysql,
                            executable_name: 'mysql' }, function(err, instance) {
                              if (err) throw err;

                              expect(instance.finished).to.exist;

                              console.log(instance);

                              done();
                            });
  });

  it('invoke embedded executable', function(done) {
    util.invokeExecutable({ apiSpec: apiSpecMysql,
                            invoker_name: 'chef',
                            instance: embeddedInstance }, function(err, instance) {
                              if (err) throw err;

                              expect(instance.finished).to.exist;

                              console.log(instance);

                              done();
                            });
  });

  after(cleanup);
});
