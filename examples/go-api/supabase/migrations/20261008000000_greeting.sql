create table greeting (
  id integer primary key,
  message text not null
);

insert into greeting (id, message) values (1, 'hello from postgres');
