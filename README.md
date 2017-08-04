# Serverless Nested Stack
Serverless plugin to Workaround for Cloudformation 200 resource limit 

**Install**

Run `npm install` in your Serverless project.

    $ npm install --save-dev https://github.com/jagdish-176/serverless-nested-stack#0.0.1

Add the plugin to your serverless.yml file

    plugins:
      - serverless-nested-stack



Nested stack created using following structure

Parent-Stack
    - LogStack
    - ApiStack

1) Parent-Stack Contains LogStack & ApiStack
2) LogStack contains LogGroups & Roles
3) ApiStack Contains Lambda functions and other resource
4) Currently Tested with Lambda Functions, Api Resources & StepFunctions 

    



