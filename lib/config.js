// Destructure environment variables for convenience
const {
  MONGO_SERVICE_HOST,
  MONGO_NAMESPACE_SERVICE_HOST,
  MONGO_DATABASE,
  MY_MONGO_PORT,
  MONGO_USE_SSL,
  MONGO_VALIDATE_SSL,
  MONGO_AUTH_USER,
  MONGO_AUTH_PWD
} = process.env;

// Default values are used if the respective environment variables are not provided
let service_host = MONGO_SERVICE_HOST || MONGO_NAMESPACE_SERVICE_HOST || 'localhost';
let mongo_database = MONGO_DATABASE || 'pacman';
let mongo_port = MY_MONGO_PORT || '27017';
let use_ssl = MONGO_USE_SSL?.toLowerCase() === 'true';
let validate_ssl = MONGO_VALIDATE_SSL?.toLowerCase() !== 'false';
let auth_details = MONGO_AUTH_USER && MONGO_AUTH_PWD ? `${MONGO_AUTH_USER}:${MONGO_AUTH_PWD}@` : '';

// Splitting the service_host variable in case it contains multiple comma-separated values
let hosts = service_host.split(',');
for (let i=0; i<hosts.length;i++) {
  connection_details += `${hosts[i]}:${mongo_port},`
}

connection_details = connection_details.replace(/,\s*$/, "");

var database = {
    url: `mongodb://${auth_details}${connection_details}/${mongo_database}`,
    options: {
        readPreference: 'secondaryPreferred'
    }
};

if(process.env.MONGO_REPLICA_SET) {
    database.options.replicaSet = process.env.MONGO_REPLICA_SET
}

if(use_ssl) {
    database.options.ssl = use_ssl
    database.options.sslValidate = validate_ssl
}

exports.database = database;
