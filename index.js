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
        this.serverless.cli.log('Split stack started......');
        const logGroups = this.removeLogGroups();
        const permissionsRules = this.removePermissionsRules();
        this.removeBuckets();
        const roles = Object.assign(this.removeRoles());
        const cfLogStack = Object.assign({},
            require('./cloudformation-template.json'));
        cfLogStack.Resources = Object.assign({}, logGroups, roles);
        cfLogStack.Outputs = {};
        this.reduceIamRoleLambdaExecutionSize(cfLogStack);
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
        const parentStack = Object.assign({},
            require('./parent-stack.json'));

        //Create Log Stack
        //this.createLogStackSync(cfTemplate);
        //Create APi Stack
        const cfApiStack = this.serverless.service
            .provider.compiledCloudFormationTemplate;
        this.addApiParameters(cfApiStack, roles);

        const cfPermissionStack = Object.assign({},
            require('./cloudformation-template.json'));
        cfPermissionStack.Resources = Object.assign({}, permissionsRules);
        cfPermissionStack.Outputs = {};
        this.addPermissionParameters(cfPermissionStack, cfApiStack, parentStack);

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
                    const permissionStackFileName = 'permissionStack.json';
                    Promise.all([this.uploadCloudFormationFile(logStackFileName, cfLogStack),
                        this.uploadCloudFormationFile(apiStackFileName, cfApiStack),
                        this.uploadCloudFormationFile(permissionStackFileName, cfPermissionStack)
                    ]).then(data => {
                        //Create parent stack
                        parentStack.Resources.ApiStack.Properties.TemplateURL = `https://s3.${this.serverless.service.provider.region}.amazonaws.com/${bucketName}/${this.serverless.service.package.artifactDirectoryName}/${apiStackFileName}`;
                        parentStack.Resources.LogStack.Properties.TemplateURL = `https://s3.${this.serverless.service.provider.region}.amazonaws.com/${bucketName}/${this.serverless.service.package.artifactDirectoryName}/${logStackFileName}`;
                        parentStack.Resources.PermissionStack.Properties.TemplateURL = `https://s3.${this.serverless.service.provider.region}.amazonaws.com/${bucketName}/${this.serverless.service.package.artifactDirectoryName}/${permissionStackFileName}`;

                        console.log(parentStack.Resources.ApiStack.Properties.TemplateURL);
                        console.log(parentStack.Resources.LogStack.Properties.TemplateURL);
                        console.log(parentStack.Resources.PermissionStack.Properties.TemplateURL);

                        this.addParametersParentStack(parentStack.Resources.ApiStack.Properties, roles);
                        this.addOutputsParentStack(parentStack, cfApiStack);

                        this.serverless.service.provider.compiledCloudFormationTemplate = parentStack;
                        fs.writeFile(this.packagePath + '/compiled-cloudformation-template.json',
                            JSON.stringify(parentStack, null, ' '));
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

    removePermissionsRules() {
        const permissions = {};
        const cf = this.serverless.service.provider
            .compiledCloudFormationTemplate;
        Object.keys(cf.Resources).forEach(key => {
            if (cf.Resources[key].Type === 'AWS::Lambda::Permission' ||
                cf.Resources[key].Type === 'AWS::Events::Rule') {
                permissions[key] = cf.Resources[key];
                delete cf.Resources[key];
            }
        });
        return permissions;
    }

    addApiParameters(cf, roles) {
        cf.Parameters = {};
        for (let key in roles) {
            if (roles.hasOwnProperty(key)) {
                cf.Parameters[key] = {
                    'Type': 'String'
                };
                cf.Parameters[key + 'ID'] = {
                    'Type': 'String'
                }
            }
        }
    }

    reduceIamRoleLambdaExecutionSize(cf) {
        for (const key in cf.Resources) {
            if (key === 'IamRoleLambdaExecution') {
                cf.Resources[key].Properties.Policies.forEach(policy=>{
                  policy.PolicyDocument.Statement.forEach(x => {
                      x.Resource = [
                          {"Fn::Sub": "arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:*:*"}
                      ]
                  });
                })
            }
        }
        Object.keys(cf.Resources).forEach(key => {
            if (cf.Resources[key].Type === 'AWS::Lambda::Permission' ||
                cf.Resources[key].Type === 'AWS::Events::Rule') {
                permissions[key] = cf.Resources[key];
                delete cf.Resources[key];
            }
        });
    }

    addPermissionParameters(cf, apiStack, parentStack) {
        parentStack.Resources.PermissionStack.Properties = {
            Parameters: {}
        };
        cf.Parameters = {};
        const parentParams = parentStack.Resources.PermissionStack.Properties.Parameters;
        for (let key in cf.Resources) {
            if (cf.Resources.hasOwnProperty(key)) {
                const resource = cf.Resources[key];
                let funcNames = [];
                if (resource.Type === 'AWS::Events::Rule') {
                    resource.Properties.Targets.forEach(fun => {
                        const funcName = fun.Arn['Fn::GetAtt'][0];
                        funcNames.push(funcName);
                        fun.Arn = {
                            "Ref": funcName
                        }
                    })
                } else {
                    const funcName = resource.Properties.FunctionName['Fn::GetAtt'][0];
                    funcNames.push(funcName);
                    resource.Properties.FunctionName = {
                        "Ref": funcName
                    };
                }
                funcNames.forEach(funcName => {
                    if (apiStack.Resources[funcName]) {
                        parentParams[funcName] = {
                            "Fn::GetAtt": [
                                "ApiStack",
                                "Outputs." + funcName
                            ]
                        };
                        cf.Parameters[funcName] = {
                            "Type": "String"
                        };
                        apiStack.Outputs[funcName] = {
                            "Value": {
                                "Fn::GetAtt": [
                                    funcName,
                                    "Arn"
                                ]
                            }
                        }
                    }
                });
            }
        }
        this.addRestApiId(cf, apiStack, parentStack);
    }

    addRestApiId(cf, apiStack, parentStack) {
        let parentParams = parentStack.Resources.PermissionStack.Properties.Parameters || {};
        for (let key in apiStack.Resources) {
            if (apiStack.Resources.hasOwnProperty(key) &&
                apiStack.Resources[key].Type === 'AWS::ApiGateway::RestApi') {
                cf.Parameters[key] = {
                    "Type": "String"
                };
                parentParams[key] = {
                    "Fn::GetAtt": [
                        "ApiStack",
                        "Outputs." + key
                    ]
                };
                apiStack.Outputs[key] = {
                    "Value": {
                        "Ref": key
                    }
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
                };
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
                    Value: {
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
