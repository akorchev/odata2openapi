import * as xml2js from 'xml-js';

import { Service } from './Service';

import { EntitySet } from './EntitySet';
import { SAPEntitySet } from './SAPData/SAPEntitySet';
import { EntityType } from './EntityType';
import { EntityProperty } from './EntityProperty';
import { Action } from './Action';
import { Function } from './Function';
import { FunctionImport } from './FunctionImport';
import { SAPFunction } from './SAPData/SAPFunction';
import { ReturnType } from './ReturnType';
import { ActionAndFunctionParameter } from './ActionAndFunctionParameter';
import { Parameter } from './Parameter';
import { ComplexType } from './ComplexType';
import { Annotation } from './Annotation';
import { Singleton } from './Singleton';
import {EnumType} from './EnumType';
import {edmTypeToSwaggerType} from './convert'

function typeNameFromType(type: string): string {
  return type ? type.split('.').pop() : null;
}

function getEntityBaseTypes(entityType, entityTypes) {
  const baseTypes = [];

  while (entityType) {
    const baseTypeName = typeNameFromType(entityType['$']['BaseType'])
    entityType = entityTypes.find(entity => entity['$']['Name'] == baseTypeName);
    if (entityType) {
      baseTypes.push(entityType);
    }
  }

  return baseTypes;
}

function parseEntitySets(namespace: string, entityContainer: any, entityTypes: any, annotations?: Array<Annotation>): Array<EntitySet> {
  const functionImports = parseFunctionImports(entityContainer['FunctionImport']);
  
  return entityContainer['EntitySet'].map(entitySet => {
    const type = typeNameFromType(entitySet['$']['EntityType']);

    const entityType = entityTypes.find(entity => entity['$']['Name'] == type);

    const entitySetFunctionImports = functionImports.filter(funcImport => funcImport['entitySet'] == entitySet['$']['Name'] );

    if (entityType) {
      return parseEntitySet(namespace, entitySet, entityType, entityTypes, annotations,entitySetFunctionImports);
    }
  }).filter(entitySet => !!entitySet);
}

function parseEntitySet(namespace: string, entitySet: any, entityType: any, entityTypes: Array<any>, annotations?: Array<Annotation>, functionImports?: Array<FunctionImport>): EntitySet {
  return {
    namespace,
    name: entitySet['$']['Name'],
    entityType: parseEntityType(entityType, entityTypes, namespace),
    annotations: parseEntityTypeAnnotations(namespace, entityType, entityTypes, annotations),
    functionImports: functionImports
  }
}

function parseSAPEntitySets(namespace: string, entityContainer: any, entityTypes: any, annotations?: Array<Annotation>, associations?:any): Array<EntitySet> {
  const functionImports = parseFunctionImports(entityContainer['FunctionImport']);
  
  return entityContainer['EntitySet'].map(entitySet => {
    const type = typeNameFromType(entitySet['$']['EntityType']);

    const entityType = entityTypes.find(entity => entity['$']['Name'] == type);

    const entitySetFunctionImports = functionImports.filter(funcImport => funcImport['entitySet'] == entitySet['$']['Name'] );

    if (entityType) {
      return parseSAPEntitySet(namespace, entitySet, entityType, entityTypes, annotations,associations,entitySetFunctionImports);
    }
  }).filter(entitySet => !!entitySet);
}

function parseSAPEntitySet(namespace: string, entitySet: any, entityType: any, entityTypes: Array<any>, annotations?: Array<Annotation>,associations?:any,functionImports?: Array<FunctionImport>): SAPEntitySet {
  //Set default value if not present, and convert to boolean via !!
  return {
    namespace,
    name: entitySet['$']['Name'],
    entityType: parseEntityType(entityType, entityTypes, namespace, associations),
    annotations: parseEntityTypeAnnotations(namespace, entityType, entityTypes, annotations),
    creatable: entitySet['$']['sap:creatable'] ==null?true:JSON.parse(entitySet['$']['sap:creatable'].toLowerCase()),
    updatable: entitySet['$']['sap:updatable']==null?true:JSON.parse(entitySet['$']['sap:updatable'].toLowerCase()),
    deleteable: entitySet['$']['sap:deletable']==null?true:JSON.parse(entitySet['$']['sap:deletable'].toLowerCase()),
    pageable: entitySet['$']['sap:pageable']==null?true:JSON.parse(entitySet['$']['sap:pageable'].toLowerCase()),
    searchable: entitySet['$']['sap:searchable']==null?false:JSON.parse(entitySet['$']['sap:searchable'].toLowerCase()),  
    label: entitySet['$']['sap:label'],
    functionImports: functionImports
  }
}

function parseEntityPaths(namespace: string, entityType: any, entityTypes: Array<any>): Array<any> {
  const paths = [];

  if (entityType['NavigationProperty']) {
    entityType['NavigationProperty'].forEach(p => {
      if (p['$']['ContainsTarget']) {
        paths.push({
          name: p['$']['Name'],
          type: p['$']['Type'],
        })
      }
    });
  }

  return paths;
}

function parseEntityTypeAnnotations(namespace: string, entityType: any, entityTypes: Array<any>, annotations?: Array<Annotation>): Array<any> {
  const allTypes = [entityType].concat(getEntityBaseTypes(entityType, entityTypes));

  const typeAnnotations: Array<string> = [];

  if (annotations) {
    annotations.forEach(a => {
      allTypes.forEach(t => {
        if (a.target == `${namespace}.${t['$']['Name']}`) {
          a.terms.forEach(term => {
            if (typeAnnotations.indexOf(term) == -1) {
              typeAnnotations.push(term)
            }
          })
        }
      })
    })
  }

  return typeAnnotations;
}

function flatten(a) {
  return Array.isArray(a) ? [].concat(...a.map(flatten)) : a;
}

function parseEntityType(entityType: any, entityTypes: Array<any>, namespace?: string,associations?:any): EntityType {
  const entityBaseTypes = getEntityBaseTypes(entityType, entityTypes);
  const entityBaseProperties = flatten(entityBaseTypes.map(t => (t['Property'] || []).map(parseProperty)))

  const result: EntityType = {
    name: entityType['$']['Name'],
    abstract: entityType['$']['Abstract'],
    properties: entityBaseProperties.concat((entityType['Property'] || []).map(parseProperty)),
    paths: parseEntityPaths(namespace, entityType, entityTypes),
    namespace
  };

  const baseTypeWithKey = entityBaseTypes.find(t => t['Key']);
  const keys = entityType['Key'] || (baseTypeWithKey && baseTypeWithKey['Key']);

  if (keys && keys.length > 0) {
    result.key = parseKey(keys[0], result.properties)
  }

  const navigationProperties = entityType['NavigationProperty'];

  if (navigationProperties && navigationProperties.length > 0) {
    navigationProperties.forEach(property => {
      const type = property['$']['Type']

      if (type) { // OData V4 only
        const ref = `#/definitions/${type.split(/[()]/)[1]}`
        const name = property['$']['Name']

        if (type.startsWith('Collection(')) {
          result.properties.push({
            name: name,
            type: 'array',
            items: {
              $ref: ref
            },
            wrapValueInQuotesInUrls: true
          })
        } else {
          const prop = {
            name: name,
            $ref: `#/definitions/${type}`,
            wrapValueInQuotesInUrls: true
          }

          const refConstraint = property['ReferentialConstraint'];
          const constraints = refConstraint ? refConstraint.map(c => {
            return {
              property: c['$']['Property'],
              refProperty: c['$']['ReferencedProperty']
            }
          }) : [];

          prop['x-ref'] = {
            name: name,
            partner: property['$']['Partner'],
            constraints: constraints
          }

          result.properties.push(prop);
        }
      }else { //OData v2 NavigationProperty with Name, Relationship, ToRole, FromRole
        const name = property['$']['Name'];
        const relationship = property['$']['Relationship'];
        const toRole = property['$']['ToRole'];
        let type;
        let multiplicity;
        if(associations && name && relationship && toRole){
          associations.forEach(association => {
            association['End'].forEach(association => {
              if(association['$']['Role']==toRole){
                type = association['$']['Type'];
                multiplicity = association['$']['Multiplicity'];
              }
            })
          })

          if (type && multiplicity && multiplicity=='1') {
            result.properties.push({
              name: name,
              $ref: `#/definitions/${type}`,
              wrapValueInQuotesInUrls: true
            })
          } else if (type && multiplicity && multiplicity=='*') 
            result.properties.push({
              name: name,
              type: 'array',
              items: {
                $ref: `#/definitions/${type}`,
              },
              wrapValueInQuotesInUrls: true
            })
        }
      }
    })
  }

  return result;
}

function parseKey(key: any, properties: Array<EntityProperty>): Array<EntityProperty> {
  const refs = key['PropertyRef'].map(propertyRef => propertyRef['$']['Name'])

  return properties.filter(property => refs.includes(property.name));
}

function parseProperty(property: any) : EntityProperty {
  const type = property['$']['Type'];

  const dontWrapValueInQuotesInUrlsTypes = ['Edm.Int16', 'Edm.Int32', 'Edm.Int64','Edm.Double','Edm.Single','Edm.Decimal', 'Edm.Guid'];

  const wrapValueInQuotesInUrls = !dontWrapValueInQuotesInUrlsTypes.includes(type);

  const result: EntityProperty = {
      required: property['$']['Nullable'] == 'false',
      name: property['$']['Name'],
      wrapValueInQuotesInUrls
  };

  if(type.startsWith('Collection(')) {
    const objectType = type.match(/^Collection\((.*)\)$/)[1];
    result.type = 'array';
    if(objectType.startsWith('Edm.')) {
      result.items = {
        type: objectType
      }
    } else {
        result.items = {
            $ref: `#/definitions/${objectType}`
        };
    }
  } else {
    result.type = type;
  }

  if(property['$']['sap:label']){
    result.description = property['$']['sap:label'];
  }
  
  return result;
}

function parseActions(actions: Array<any>): Array<Action> {
  return actions && actions.length ? actions.map(action => {
    return {
      name: action['$']['Name'],
      isBound: action['$']['IsBound'],
      entitySetPath: action['$']['EntitySetPath'],
      returnType: parseReturnTypes(action['ReturnType']),
      parameters: parseActionAndFunctionParameters(action['Parameter']),
    }
  }) : [];
}

function parseFunctions(functions: Array<any>): Array<Function> {
  return functions && functions.length ? functions.map(func => {
    return {
      name: func['$']['Name'],
      isBound: func['$']['IsBound'],
      isComposable: func['$']['IsComposable'],
      entitySetPath: func['$']['EntitySetPath'],
      returnType: parseReturnTypes(func['ReturnType']),
      parameters: parseActionAndFunctionParameters(func['Parameter']),
    }
  }) : [];
}

function parseFunctionImports(functionImports: Array<any>): Array<FunctionImport> {
  return functionImports && functionImports.length ? functionImports.map(funcImport => {
    return {
      name: funcImport['$']['Name'],
      label: funcImport['$']['sap:label'],
      httpMethod: funcImport['$']['m:HttpMethod'],
      entitySet: funcImport['$']['EntitySet'],
      returnType: funcImport['$']['ReturnType'],
      parameters: parseParameters(funcImport['Parameter']),
    }
  }) : [];
}

function parseSAPFunctions(functions: Array<any>): Array<SAPFunction> {
  return functions && functions.length ? functions.map(func => {
    return {
      name: func['$']['Name'],
      isBound: func['$']['IsBound'],
      isComposable: func['$']['IsComposable'],
      entitySetPath: func['$']['EntitySetPath'],
      returnType: parseReturnTypes(func['ReturnType']),
      parameters: parseActionAndFunctionParameters(func['Parameter']),
      label: func['$']['sap-label'],
      actionFor: func['$']['sap-action-for']
    }
  }) : [];
}

function parseReturnTypes(returnType: any): ReturnType {
  return returnType && returnType[0] ? {
    type: returnType[0]['$']['Type'],
    nullable: !(returnType[0]['$']['Nullable'] == 'false'),
  } : null;
}

function parseActionAndFunctionParameters(parameters: any): Array<ActionAndFunctionParameter> {
  return parameters && parameters.length ? parameters.map(parameter => {
    return {
      name: parameter['$']['Name'],
      type: parameter['$']['Type'],
      nullable: !(parameter['$']['Nullable'] == 'false'),
    }
  }) : [];
}

function parseParameters(parameters: any): Array<Parameter> {
  return parameters && parameters.length ? parameters.map(parameter => {
    return {
      name: parameter['$']['Name'],
      in: 'query',
      type: edmTypeToSwaggerType(parameter['$']['Type']).name,
      required:true
    }
  }) : [];
}


function parseComplexTypes(complexTypes: Array<any>, schemas: Array<any>): Array<ComplexType> {
  return complexTypes && complexTypes.length ? complexTypes.map(t => {
    const schema = schemas.find(s => s['ComplexType'].find(ct => ct == t))

    return {
      name: t['$']['Name'],
      properties: (t['Property'] || []).map(parseProperty),
      namespace: schema ? schema['$']['Namespace'] : null
    }
  }) : [];
}

function parseEnumTypes(enumTypes: Array<any>, schemas: Array<any>): Array<EnumType> {
    return enumTypes && enumTypes.length ? enumTypes.map(t => {
        const schema = schemas.find(s => s['EnumType'].find(ct => ct == t))

        return {
            name: t['$']['Name'],
            memberNames: (t['Member'] || []).map(m => m['$']['Name']),
            namespace: schema ? schema['$']['Namespace'] : null
        }
    }) : [];
}

function parseAnnotations(annotations: Array<any>): Array<Annotation> {
  return annotations && annotations.length ? annotations.map(t => {
    return {
      target: t['$']['Target'],
      terms: (t['Annotation'] || []).map(a => a['$']['Term'])
    }
  }) : [];
}

function parseSingletons(singletons: Array<any>, entitySets: Array<EntitySet>): Array<Singleton> {
  return singletons && singletons.length ? singletons.map(s => {
    const properties = [];

    (s['NavigationPropertyBinding'] || []).forEach(n => {
      const entitySet = entitySets.find(es => es.name == n['$']['Target']);
      if (entitySet) {
        const path = n['$']['Path'];
        if (path) {
          properties.push({
            name: path.split('/').pop(),
            type: path.indexOf('/') != -1 ? `${entitySet.namespace}.${entitySet.entityType.name}` :
              `Collection(${entitySet.namespace}.${entitySet.entityType.name})`
          });
        }
      }
    });

    return {
      name: s['$']['Name'],
      type: s['$']['Type'],
      properties
    }
  }) : [];
}

function parseEntityTypes(entityTypes: Array<any>, schemas: Array<any>): Array<EntityType> {
  return entityTypes.map(et => {
    const schema = schemas.find(s => s['EntityType'].find(t => t == et))
    return parseEntityType(et, entityTypes, schema ? schema['$']['Namespace'] : null);
  });
}

function parse(xml: string): Promise<Service> {
  return new Promise<Service>((resolve, reject) => {

    const metadata = xml2js.xml2js(xml, { compact: true, trim: true, alwaysArray: true, attributesKey: '$' });

    const version = metadata['edmx:Edmx']['$']['Version']

    //isSAPDataService=true if there exist xml namespace for http://www.sap.com/Protocols/SAPData
    const xmlNamespaces= Object.keys(metadata['edmx:Edmx']['$']).filter(function(key){
      return key.indexOf('xmlns')==0;
    }).map (key => metadata['edmx:Edmx']['$'][key]);
    let isSAPDataService = xmlNamespaces.some(xmlNamespace => xmlNamespace === 'http://www.sap.com/Protocols/SAPData');

    const [dataServices] = metadata['edmx:Edmx'][0]['edmx:DataServices'];

    const schemas = dataServices['Schema'];


    const entityContainerSchema = schemas.find(schema => schema['EntityContainer'])

      if (!entityContainerSchema) {
        reject(new Error('Cannot find EntityContainer element.'));
      }

      const [entityContainer] = entityContainerSchema['EntityContainer']

      const defaultNamespace = entityContainerSchema['$']['Namespace'];

      const actions = parseActions(entityContainerSchema['Action']);
      const functions = parseFunctions(entityContainerSchema['Function']);
      const annotations = parseAnnotations(entityContainerSchema['Annotations']);

      const entitySets: Array<EntitySet> = [];
      const allEntityTypes: Array<any> = [];
      const allComplexTypes: Array<any> = [];
      const allEnumTypes: Array<EnumType> = [];

      schemas.forEach(schema => {
        if (schema['EntityType']) {
          const namespace = schema['$']['Namespace'];
          const schemaEntityTypes = schema['EntityType'];
          allEntityTypes.push(...schemaEntityTypes);
          if(isSAPDataService){
            entitySets.push(...parseSAPEntitySets(namespace, entityContainer, schemaEntityTypes, annotations, schema['Association']));
          }else {
            entitySets.push(...parseEntitySets(namespace, entityContainer, schemaEntityTypes, annotations));
          }
          
        }

        if (schema['ComplexType']) {
          const schemaComplexTypes = schema['ComplexType'];
          allComplexTypes.push(...schemaComplexTypes);
        }

        if (schema['EnumType']) {
            const schemaEnumTypes = schema['EnumType'];
            allEnumTypes.push(...schemaEnumTypes);
        }
      });

      const complexTypes = parseComplexTypes(entityContainerSchema['ComplexType'], schemas);

      const singletons = parseSingletons(entityContainer['Singleton'], entitySets);

      const entityTypes = parseEntityTypes(allEntityTypes, schemas);

      const enumTypes = parseEnumTypes(allEnumTypes, schemas);

      resolve({ entitySets: entitySets, version: version, complexTypes, singletons, actions, functions, defaultNamespace, entityTypes, enumTypes })
  });
}

export default parse;
