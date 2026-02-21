CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  term TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS enrollments (
  user_id TEXT NOT NULL,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, class_id)
);

CREATE TABLE IF NOT EXISTS user_directory (
  user_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL DEFAULT '',
  user_email TEXT NOT NULL DEFAULT '',
  profile_picture_url TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  skills TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_section TEXT NOT NULL,
  project_section_id UUID,
  owner_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  max_group_size INTEGER NOT NULL DEFAULT 4 CHECK (max_group_size >= 2 AND max_group_size <= 20),
  created_by_user_id TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (class_id, name)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'groups_project_section_id_fkey'
  ) THEN
    ALTER TABLE groups
    ADD CONSTRAINT groups_project_section_id_fkey
    FOREIGN KEY (project_section_id)
    REFERENCES project_sections(id)
    ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS group_requests (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

INSERT INTO project_sections (class_id, name, description, max_group_size, created_by_user_id) VALUES
  ('CPSC110', 'Term Project', 'Main term-long collaboration project', 4, 'system'),
  ('CPSC210', 'Milestone A', 'Initial design and planning team', 5, 'system'),
  ('CPSC210', 'Milestone B', 'Implementation and integration group', 5, 'system'),
  ('CPSC221', 'Algorithm Project', 'Group project focused on algorithm analysis', 4, 'system'),
  ('MATH200', 'Problem Set Team', 'Collaborative problem solving section', 3, 'system'),
  ('STAT200', 'Data Report', 'Applied statistics write-up group', 4, 'system'),
  ('ECON101', 'Case Study', 'Microeconomics case-study group', 4, 'system')
ON CONFLICT (class_id, name) DO NOTHING;

INSERT INTO classes (id, title, term, description) VALUES
  ('CPSC110', 'Computation, Programs, and Programming', '2026W', 'Foundations of programming and software construction.'),
  ('CPSC210', 'Software Construction', '2026W', 'Object-oriented design and program architecture.'),
  ('CPSC221', 'Basic Algorithms and Data Structures', '2026W', 'Core algorithms and data structure implementation.'),
  ('MATH200', 'Calculus III', '2026W', 'Multivariable calculus and vector fields.'),
  ('STAT200', 'Elementary Statistics for Applications', '2026W', 'Applied statistics and inference.'),
  ('ECON101', 'Principles of Microeconomics', '2026W', 'Microeconomic theory and applications.')
ON CONFLICT (id) DO NOTHING;
