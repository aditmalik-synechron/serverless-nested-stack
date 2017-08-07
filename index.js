'use strict';
const uploadArtifacts = require('./lib/uploadArtifacts');
const path = require('path');
const fs = require('fs');
class ServerlessNestedPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this.servicePath = this.serverless.config.servicePath || '';
    this.packagePath = this.options.package ||
      this.serverless.service.package.path ||
      path.join(this.servicePath, '.serverless');
    Object.assign(this, uploadArtifacts);
    this.commands = {
      nestedPlugin: {
        commands: {
          data: {
            lifecycleEvents: [
              'prepare'
            ]
          }
        }
      },
    };

    this.hooks = {
      'aws:deploy:deploy:createStack': () =>
        this.serverless.pluginManager.run(['nestedPlugin', 'data']),
      'nestedPlugin:data:prepare': this.splitStack.bind(this)
    };
  }

  splitStack() {
    this.serverless.cli.log('Split stack started...');
    const logGroups = this.removeLogGroups();
    this.removeBuckets();
    const roles = Object.assign(this.removeRoles());
    const cfLogStack = Object.assign({},
      require('./cloudformation-template.json'));
    cfLogStack.Resources = Object.assign({}, logGroups, roles);
    cfLogStack.Outputs = {};
    for (let key in roles) {
      if (!roles.hasOwnProperty(key)) {
        continue;
      }
      cfLogStack.Outputs[key] = {
        'Value': {
          'Fn::GetAtt': [
            key,
            'Arn'
          ]
        }
      };
      cfLogStack.Outputs[key + 'ID'] = {
        'Value': {
          'Ref': key
        }
      }
    }

    //Create Log Stack
    //this.createLogStackSync(cfTemplate);
    //Create APi Stack
    const cfApiStack = this.serverless.service
      .provider.compiledCloudFormationTemplate;
    this.addParameters(cfApiStack, roles);

    return new Promise((resolve, reject) => {
      this.provider.getServerlessDeploymentBucketName(
        this.serverless.service.provider.stage,
        this.serverless.service.provider.region)
        .then((bucketName) => {
          this.bucketName = bucketName;
          this.setArnForLambdaFunctions(cfApiStack, bucketName);
          this.setArnForStepMachine(cfApiStack);
          this.setRefForPolicy(cfApiStack);
          const logStackFileName = 'logStack.json';
          const apiStackFileName = 'apiStack.json';
          Promise.all([this.uploadCloudFormationFile(logStackFileName, cfLogStack),
            this.uploadCloudFormationFile(apiStackFileName, cfApiStack)
          ]).then(data => {
            //Create parent stack
            const parentTemplate = Object.assign({},
              require('./parent-stack.json'));
            parentTemplate.Resources.ApiStack.Properties.TemplateURL = `https://s3.${this.serverless.service.provider.region}.amazonaws.com/${bucketName}/${this.serverless.service.package.artifactDirectoryName}/${apiStackFileName}`;
            parentTemplate.Resources.LogStack.Properties.TemplateURL = `https://s3.${this.serverless.service.provider.region}.amazonaws.com/${bucketName}/${this.serverless.service.package.artifactDirectoryName}/${logStackFileName}`;
            console.log(parentTemplate.Resources.ApiStack.Properties.TemplateURL);
            console.log(parentTemplate.Resources.LogStack.Properties.TemplateURL);
            this.addParametersParentStack(parentTemplate.Resources.ApiStack.Properties, roles);
            this.addOutputsParentStack(parentTemplate, cfApiStack);
            this.serverless.service.provider.compiledCloudFormationTemplate = parentTemplate;
            fs.writeFile(this.packagePath + '/compiled-cloudformation-template.json',
              JSON.stringify(parentTemplate, null, ' '));
            resolve();
          }).catch(reject);
        });

    });
  }

  removeRoles() {
    const logGroups = {};
    const cf = this.serverless.service.provider
      .compiledCloudFormationTemplate;
    Object.keys(cf.Resources).forEach(key => {
      if (cf.Resources[key].Type === 'AWS::IAM::Role') {
        logGroups[key] = cf.Resources[key];
        delete cf.Resources[key];
      }
    });
    return logGroups;
  }

  removeBuckets() {
    const buckets = {};
    const cf = this.serverless.service.provider
      .compiledCloudFormationTemplate;
    Object.keys(cf.Resources).forEach(key => {
      if (cf.Resources[key].Type === 'AWS::S3::Bucket') {
        buckets[key] = cf.Resources[key];
        delete cf.Resources[key];
      }
    });
    delete cf.Outputs.ServerlessDeploymentBucketName;
    return buckets;
  }

  removeLogGroups() {
    const logGroups = {};
    const cf = this.serverless.service.provider
      .compiledCloudFormationTemplate;
    Object.keys(cf.Resources).forEach(key => {
      if (cf.Resources[key].Type === 'AWS::Logs::LogGroup') {
        logGroups[key] = cf.Resources[key];
        delete cf.Resources[key];
      }
    });
    return logGroups;
  }

  addParameters(cf, roles) {
    cf.Parameters = {};
    for (let key in roles) {
      if (roles.hasOwnProperty(key)) {
        cf.Parameters[key] = {
          'Type': 'String'
        }
        cf.Parameters[key + 'ID'] = {
          'Type': 'String'
        }
      }
    }
  }

  addParametersParentStack(cf, roles) {
    cf.Parameters = cf.Parameters || {};
    for (let key in roles) {
      if (roles.hasOwnProperty(key)) {
        cf.Parameters[key] = {
          'Fn::GetAtt': ['LogStack', `Outputs.${key}`]
        }
        cf.Parameters[key + 'ID'] = {
          'Fn::GetAtt': ['LogStack', `Outputs.${key}ID`]
        }
      }
    }
    //cf.Parameters.ServerlessDeploymentBucket = bucketName;
  }
  addOutputsParentStack(cf, apiStack) {
        cf.Outputs = cf.Outputs || {};
        for (let key in apiStack.Outputs) {
            if (apiStack.Outputs.hasOwnProperty(key)) {
                cf.Outputs[key] = {
                    Value:{
                        'Fn::GetAtt': ['ApiStack', `Outputs.${key}`]
                    }
                }
            }
        }
        //cf.Parameters.ServerlessDeploymentBucket = bucketName;
    }
  setRefForPolicy(cf) {
    Object.keys(cf.Resources).forEach(key => {
      const Func = cf.Resources[key];
      if (Func.Type === 'AWS::IAM::Policy') {
        if (Func.Properties.Roles) {
          if (Func.Properties.Roles && Func.Properties.Roles.length) {
            Func.Properties.Roles = Func.Properties.Roles.map(obj => {
              return {
                Ref: obj.Ref + 'ID'
              }
            });
          }
        }
      }
    });
  }

  setArnForLambdaFunctions(cf, s3Bucket) {
    Object.keys(cf.Resources).forEach(key => {
      const Func = cf.Resources[key];
      if (Func.Type === 'AWS::Lambda::Function') {
        if (Func.Properties.Role) {
          if (Func.Properties.Role['Fn::GetAtt']) {
            Func.Properties.Role = {
              Ref: Func.Properties.Role['Fn::GetAtt'][0]
            };
          }
          if (Func.Properties.Code && Func.Properties.Code.S3Bucket) {
            Func.Properties.Code.S3Bucket = s3Bucket;
          }
        }
        delete Func.DependsOn;
      }
    });
  }

  setArnForStepMachine(cf) {
    Object.keys(cf.Resources).forEach(key => {
      const Func = cf.Resources[key];
      if (Func.Type === 'AWS::StepFunctions::StateMachine') {
        if (Func.Properties.RoleArn && Func.Properties.RoleArn['Fn::GetAtt']) {
          Func.Properties.RoleArn = {
            Ref: Func.Properties.RoleArn['Fn::GetAtt'][0]
          };
        }
        delete Func.DependsOn;
      }
    });
  }
}

module.exports = ServerlessNestedPlugin;
